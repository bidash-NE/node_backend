// src/routes/sms.routes.js
import express from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import {
  insertMessage,
  updateMessage,
  getMessage,
  listMessages,
} from "../db/messages.repo.js";

/**
 * Role-based request limits (per minute). Adjust as you like.
 */
const LIMITS = {
  otp: { windowMs: 60_000, max: 120 },
  marketing: { windowMs: 60_000, max: 20 },
  system: { windowMs: 60_000, max: 240 },
};

/**
 * Create rate limit instances ONCE (module init time)
 */
const commonLimiterOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-api-key"] || "unknown"),
  message: { ok: false, error: "RATE_LIMITED" },
};

const limiterOtp = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.otp.windowMs,
  max: LIMITS.otp.max,
});
const limiterMarketing = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.marketing.windowMs,
  max: LIMITS.marketing.max,
});
const limiterSystem = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.system.windowMs,
  max: LIMITS.system.max,
});

function getKeyRole(xApiKey) {
  const key = String(xApiKey || "").trim();
  if (!key) return null;

  if (config.apiKeys.otp && key === config.apiKeys.otp) return "otp";
  if (config.apiKeys.marketing && key === config.apiKeys.marketing)
    return "marketing";
  if (config.apiKeys.system && key === config.apiKeys.system) return "system";
  if (config.apiKeys.master && key === config.apiKeys.master) return "master";

  return null;
}

function requireApiKey(req, res, next) {
  const role = getKeyRole(req.headers["x-api-key"]);
  if (!role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  req.apiRole = role;
  next();
}

function applyRoleLimiter(req, res, next) {
  // Treat master key like system
  const role = req.apiRole === "master" ? "system" : req.apiRole;

  if (role === "otp") return limiterOtp(req, res, next);
  if (role === "marketing") return limiterMarketing(req, res, next);
  return limiterSystem(req, res, next);
}

function normalizeTo(v) {
  return String(v || "").trim();
}

export function smsRouter({ smpp, logger }) {
  const router = express.Router();

  // Auth + limiter applied to all sms endpoints
  router.use(requireApiKey);
  router.use(applyRoleLimiter);

  /**
   * POST /api/sms/send
   * body: { to, text, from? }
   *
   * ✅ Fix: wrap EVERYTHING in try/catch so DB errors don't crash the process
   * (502 from ingress is often an app crash / connection reset)
   */
  router.post("/send", async (req, res) => {
    try {
      const { to, text, from } = req.body || {};
      const toMsisdn = normalizeTo(to);
      const msgText = String(text || "");

      if (!toMsisdn || !msgText) {
        return res
          .status(400)
          .json({ ok: false, error: "to and text are required" });
      }

      // marketing key cannot override sender id
      if (
        req.apiRole === "marketing" &&
        from &&
        normalizeTo(from) !== config.smpp.defaultSenderId
      ) {
        return res
          .status(403)
          .json({ ok: false, error: "MARKETING_SENDER_NOT_ALLOWED" });
      }

      const id = uuidv4();
      const now = new Date();

      // Save initial record (if this fails, return 500 instead of crashing)
      await insertMessage({
        id,
        to_msisdn: toMsisdn,
        sender_id: normalizeTo(from || config.smpp.defaultSenderId),
        text: msgText,
        status: "QUEUED",
        error: null,
        smpp_message_id: null,
        created_at: now,
        sent_at: null,
        delivered_at: null,
      });

      try {
        const { smppMessageId } = await smpp.sendSms({
          to: toMsisdn,
          text: msgText,
          from: from ? normalizeTo(from) : undefined,
        });

        await updateMessage(id, {
          status: "SENT",
          smpp_message_id: smppMessageId,
          sent_at: new Date(),
          error: null,
        });

        return res.json({
          ok: true,
          id,
          smppMessageId,
          status: "SENT",
          role: req.apiRole,
        });
      } catch (err) {
        logger?.error?.({ err }, "send failed");

        // don't let update failure crash the request
        await updateMessage(id, {
          status: "FAILED",
          error: err?.message || "SEND_FAILED",
        }).catch((e) => logger?.error?.({ e }, "update failed after send error"));

        return res.status(503).json({
          ok: false,
          id,
          error: err?.message || "SEND_FAILED",
        });
      }
    } catch (err) {
      logger?.error?.({ err }, "send handler failed");
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });

  /**
   * POST /api/sms/bulk
   * body: { messages: [{to,text,from?}, ...] }
   *
   * ✅ Fix: wrap EVERYTHING in try/catch
   * ✅ Optional safety: cap bulk size (prevents 1 request sending 1000s)
   */
  const MAX_BULK = Number(process.env.MAX_BULK || 50);

  router.post("/bulk", async (req, res) => {
    try {
      const { messages } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "messages[] required" });
      }

      if (messages.length > MAX_BULK) {
        return res
          .status(413)
          .json({ ok: false, error: "BULK_TOO_LARGE", max: MAX_BULK });
      }

      const results = [];

      for (const m of messages) {
        const toMsisdn = normalizeTo(m?.to);
        const msgText = String(m?.text || "");
        const from = m?.from;

        if (!toMsisdn || !msgText) {
          results.push({ ok: false, error: "INVALID_MESSAGE", message: m });
          continue;
        }

        if (
          req.apiRole === "marketing" &&
          from &&
          normalizeTo(from) !== config.smpp.defaultSenderId
        ) {
          results.push({
            ok: false,
            error: "MARKETING_SENDER_NOT_ALLOWED",
            to: toMsisdn,
          });
          continue;
        }

        const id = uuidv4();
        const now = new Date();

        try {
          await insertMessage({
            id,
            to_msisdn: toMsisdn,
            sender_id: normalizeTo(from || config.smpp.defaultSenderId),
            text: msgText,
            status: "QUEUED",
            error: null,
            smpp_message_id: null,
            created_at: now,
            sent_at: null,
            delivered_at: null,
          });
        } catch (err) {
          logger?.error?.({ err }, "insert failed (bulk)");
          results.push({ ok: false, id, error: "DB_INSERT_FAILED" });
          continue;
        }

        try {
          const { smppMessageId } = await smpp.sendSms({
            to: toMsisdn,
            text: msgText,
            from: from ? normalizeTo(from) : undefined,
          });

          await updateMessage(id, {
            status: "SENT",
            smpp_message_id: smppMessageId,
            sent_at: new Date(),
            error: null,
          });

          results.push({ ok: true, id, smppMessageId, status: "SENT" });
        } catch (err) {
          await updateMessage(id, {
            status: "FAILED",
            error: err?.message || "SEND_FAILED",
          }).catch((e) =>
            logger?.error?.({ e }, "update failed after bulk send error")
          );

          results.push({ ok: false, id, error: err?.message || "SEND_FAILED" });
        }
      }

      return res.json({ ok: true, role: req.apiRole, results });
    } catch (err) {
      logger?.error?.({ err }, "bulk handler failed");
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });

  /**
   * GET /api/sms/:id
   */
  router.get("/:id", async (req, res) => {
    try {
      const row = await getMessage(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return res.json({ ok: true, message: row });
    } catch (err) {
      logger?.error?.({ err }, "get message failed");
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });

  /**
   * GET /api/sms?status=SENT&to=...&limit=50&offset=0
   */
  router.get("/", async (req, res) => {
    try {
      const { status, to } = req.query;
      const limit = Number(req.query.limit || 50);
      const offset = Number(req.query.offset || 0);

      const rows = await listMessages({
        status: status ? String(status) : undefined,
        to: to ? String(to) : undefined,
        limit,
        offset,
      });

      return res.json({ ok: true, role: req.apiRole, messages: rows });
    } catch (err) {
      logger?.error?.({ err }, "list messages failed");
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  });

  return router;
}
