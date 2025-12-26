// controllers/scheduledOrdersController.js
const db = require("../config/db");
const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
  parseScheduledToEpochMs,
  epochToBhutanIso,
} = require("../models/scheduledOrderModel");

const ALLOWED_SERVICE_TYPES = new Set(["FOOD", "MART"]);

const MAX_PHOTOS = 6;

/**
 * ✅ Supports:
 * - JSON body (application/json)
 * - multipart/form-data (multer), where files come in req.files and body fields may be strings
 *
 * ✅ Enforces: max 6 photos total (uploaded files + any special_photos provided in body)
 *
 * NOTE:
 * - Make sure your route uses the upload middleware BEFORE this controller if using multipart:
 *   router.post("/scheduled-orders", uploadDeliveryPhotos, scheduleOrder);
 * - If you are only sending JSON with URIs (no files), this still works.
 */
exports.scheduleOrder = async (req, res) => {
  try {
    // ---------- helpers ----------
    const safeJsonParse = (v) => {
      if (v == null) return v;
      if (typeof v !== "string") return v;
      const s = v.trim();
      if (!s) return v;
      // parse only if it looks like JSON
      if (
        (s.startsWith("{") && s.endsWith("}")) ||
        (s.startsWith("[") && s.endsWith("]"))
      ) {
        try {
          return JSON.parse(s);
        } catch {
          return v;
        }
      }
      return v;
    };

    const asNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    const normalizeBool = (v) => {
      if (typeof v === "boolean") return v;
      const s = String(v || "")
        .trim()
        .toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
      return v;
    };

    // ---------- raw body ----------
    // In multipart, req.body fields are usually strings.
    // We do NOT destructure req.body directly without guarding (your server log showed req.body undefined sometimes).
    const body = req.body || {};
    console.log("[scheduleOrder] content-type:", req.headers["content-type"]);
    console.log("[scheduleOrder] req.body keys:", Object.keys(body || {}));
    console.log(
      "[scheduleOrder] req.files keys:",
      Object.keys(req.files || {})
    );

    // ---------- extract required fields ----------
    const user_id = body.user_id ?? body.userId ?? body.userid;
    const scheduled_at =
      body.scheduled_at ?? body.scheduledAt ?? body.scheduled;

    const userId = asNumber(user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id is required and must be a number.",
      });
    }

    if (!scheduled_at) {
      return res
        .status(400)
        .json({ success: false, message: "scheduled_at is required." });
    }

    // ✅ Bhutan-correct parsing (no timezone => treat as Bhutan local)
    const epochMs = parseScheduledToEpochMs(scheduled_at);
    if (!Number.isFinite(epochMs)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid scheduled_at format. Use ISO with +06:00 or without timezone for Bhutan local.",
      });
    }

    if (epochMs <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled time must be in the future.",
      });
    }

    // ---------- build orderPayload ----------
    // everything except user_id and scheduled_at
    const orderPayload = { ...body };
    delete orderPayload.user_id;
    delete orderPayload.userId;
    delete orderPayload.userid;
    delete orderPayload.scheduled_at;
    delete orderPayload.scheduledAt;
    delete orderPayload.scheduled;

    // Parse JSON-like string fields (common with multipart)
    // Only parse fields that are known to often arrive stringified.
    orderPayload.items = safeJsonParse(orderPayload.items);
    orderPayload.totals = safeJsonParse(orderPayload.totals);
    orderPayload.delivery_address = safeJsonParse(
      orderPayload.delivery_address
    );
    orderPayload.special_photos = safeJsonParse(orderPayload.special_photos);

    // Normalize a few common types if they come as strings
    if (orderPayload.priority != null)
      orderPayload.priority = normalizeBool(orderPayload.priority);
    if (orderPayload.delivery_lat != null)
      orderPayload.delivery_lat = asNumber(orderPayload.delivery_lat);
    if (orderPayload.delivery_lng != null)
      orderPayload.delivery_lng = asNumber(orderPayload.delivery_lng);
    if (orderPayload.business_id != null)
      orderPayload.business_id = asNumber(orderPayload.business_id);

    // ---------- validate items ----------
    if (!Array.isArray(orderPayload.items) || !orderPayload.items.length) {
      return res.status(400).json({
        success: false,
        message: "Order items are required.",
      });
    }

    // ---------- service_type validation ----------
    const serviceType = String(orderPayload.service_type || "")
      .trim()
      .toUpperCase();

    if (!serviceType || !ALLOWED_SERVICE_TYPES.has(serviceType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }
    orderPayload.service_type = serviceType;

    // ---------- handle photos (URIs + uploaded files) ----------
    // 1) photos from body (JSON)
    let bodyUris = [];
    if (Array.isArray(orderPayload.special_photos)) {
      bodyUris = orderPayload.special_photos
        .map((u) => (u == null ? "" : String(u).trim()))
        .filter(Boolean);
    } else if (typeof orderPayload.special_photos === "string") {
      // if still string somehow
      bodyUris = [orderPayload.special_photos.trim()].filter(Boolean);
    }

    // 2) uploaded files from multer (multipart)
    // Accept multiple possible field names (depends on your frontend & multer config)
    const files = []
      .concat(req.files?.delivery_photo || [])
      .concat(req.files?.delivery_photos || [])
      .concat(req.files?.image || [])
      .concat(req.files?.images || []);

    // Convert uploaded files to web paths (must match how you serve /uploads)
    // Your middleware uses: /uploads/order_delivery_photos/<filename>
    const uploadedUris = files
      .map((f) =>
        f?.filename ? `/uploads/order_delivery_photos/${f.filename}` : null
      )
      .filter(Boolean);

    // Enforce max 6 across both sources
    const merged = [...bodyUris, ...uploadedUris].slice(0, MAX_PHOTOS);

    if (bodyUris.length + uploadedUris.length > MAX_PHOTOS) {
      return res.status(400).json({
        success: false,
        message: `Max ${MAX_PHOTOS} photos allowed.`,
      });
    }

    orderPayload.special_photos = merged;

    // ---------- save ----------
    const saved = await addScheduledOrder(scheduled_at, orderPayload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,

      scheduled_at_utc: saved.scheduled_at,
      scheduled_at_local: saved.scheduled_at_local,

      service_type: saved.order_payload?.service_type || serviceType,

      // optional debug/confirm
      photo_count: merged.length,
      photos: merged,
    });
  } catch (err) {
    console.error("scheduleOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id parameter." });
    }

    const list = await getScheduledOrdersByUser(userId);

    // Latest first
    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0)
    );

    const mapped = sorted.map((job) => ({
      job_id: job.job_id,
      user_id: job.user_id,
      business_id: job.business_id ?? null,

      scheduled_at_utc: job.scheduled_at ?? null,
      scheduled_at_local:
        job.scheduled_at_local ??
        (Number.isFinite(job.scheduled_epoch_ms)
          ? epochToBhutanIso(job.scheduled_epoch_ms)
          : null),

      created_at_utc: job.created_at ?? null,

      order_payload: job.order_payload,
    }));

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrders error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

exports.listScheduledOrdersByBusiness = async (req, res) => {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId) || businessId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid businessId parameter.",
      });
    }

    const list = await getScheduledOrdersByBusiness(businessId);

    if (!list.length) return res.json({ success: true, data: [] });

    const userIds = [
      ...new Set(
        list
          .map((j) => j.user_id)
          .filter((uid) => uid != null && Number.isFinite(Number(uid)))
          .map((x) => Number(x))
      ),
    ];

    let userNameById = new Map();
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT user_id, user_name FROM users WHERE user_id IN (${placeholders})`,
        userIds
      );
      userNameById = new Map(rows.map((r) => [Number(r.user_id), r.user_name]));
    }

    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0)
    );

    const mapped = sorted.map((job) => {
      const uid = Number(job.user_id);
      return {
        job_id: job.job_id,
        user_id: job.user_id,
        name: userNameById.get(uid) || null,
        business_id: job.business_id ?? null,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        created_at_utc: job.created_at ?? null,

        order_payload: job.order_payload,
      };
    });

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrdersByBusiness error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

exports.cancelScheduledOrder = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const jobId = req.params.jobId;

    if (!Number.isFinite(userId) || userId <= 0 || !jobId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id or jobId.",
      });
    }

    const ok = await cancelScheduledOrderForUser(jobId, userId);
    if (!ok) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found for this user.",
      });
    }

    return res.json({
      success: true,
      message: "Scheduled order cancelled.",
    });
  } catch (err) {
    console.error("cancelScheduledOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
