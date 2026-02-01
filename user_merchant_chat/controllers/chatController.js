// File: controllers/chatController.js
// ✅ Updated listConversations:
// - CUSTOMER lists by x-user-id
// - MERCHANT lists by x-business-id only (no x-user-id required for listing)

const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

// Robust db import (supports module.exports = pool OR { pool })
const dbMod = require("../config/db");
const db =
  (dbMod && typeof dbMod.query === "function" && dbMod) ||
  (dbMod && dbMod.pool && typeof dbMod.pool.query === "function" && dbMod.pool) ||
  null;

if (!db) {
  console.error("[DB] Invalid export from config/db.js ->", dbMod);
  throw new Error("DB pool not initialized. config/db.js must export mysql pool.");
}

function ts() {
  return new Date().toISOString();
}
function log(...a) {
  console.log(`[${ts()}]`, ...a);
}

function cleanStr(v) {
  return (v ?? "").toString().trim();
}

/* ==================== ACTOR PARSERS ==================== */

// CUSTOMER must have x-user-id
function getCustomerActor(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  if (role !== "CUSTOMER") return null;

  const id = Number(req.headers["x-user-id"] || 0);
  if (!id) return null;

  return { role: "CUSTOMER", id };
}

// MERCHANT listing uses business_id (no x-user-id required for list)
function getMerchantBusinessId(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  if (role !== "MERCHANT") return null;

  const bid =
    Number(req.headers["x-business-id"] || 0) ||
    Number(req.query.business_id || 0) ||
    0;

  return bid ? String(bid) : null;
}

// For other endpoints (messages / read) you can keep strict actor check:
function getActorStrict(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  const id = Number(req.headers["x-user-id"] || 0);
  if (!["CUSTOMER", "MERCHANT"].includes(role) || !id) return null;
  return { role, id };
}

/* ==================== MEDIA URL BUILDER ==================== */

function buildStoredMediaUrl(req, fieldname, filename) {
  const rel = upload.toWebPath(fieldname, filename);

  // ✅ force chat images served under "/chat/uploads/..."
  let out = rel;
  if (fieldname === "chat_image") {
    out = `/chat${rel.startsWith("/") ? rel : `/${rel}`}`;
  }

  const base = (process.env.MEDIA_BASE_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}${out}` : out;
}

/* ==================== DB FETCHERS (for enrichment) ==================== */

async function fetchUsersByIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");

  const [rows] = await db.query(
    `SELECT user_id, user_name AS display_name, profile_image
     FROM users
     WHERE user_id IN (${ph})`,
    ids,
  );

  const map = new Map();
  for (const r of rows) {
    const uid = Number(r.user_id);
    map.set(uid, {
      name: cleanStr(r.display_name),
      profile_image: cleanStr(r.profile_image),
    });
  }
  return map;
}

async function fetchBusinessesByIds(businessIds) {
  const ids = [...new Set((businessIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const ph = ids.map(() => "?").join(",");

  const [rows] = await db.query(
    `SELECT business_id, business_name, business_logo
     FROM merchant_business_details
     WHERE business_id IN (${ph})`,
    ids,
  );

  const map = new Map();
  for (const r of rows) {
    const bid = Number(r.business_id);
    map.set(bid, {
      business_name: cleanStr(r.business_name),
      business_logo: cleanStr(r.business_logo),
    });
  }
  return map;
}

/**
 * ✅ Derive merchant user id from business_id (used only for conversation creation)
 * Adjust column names if needed.
 */
async function fetchMerchantIdByBusinessId(businessId) {
  const bid = Number(businessId || 0);
  if (!bid) return null;

  const sqlVariants = [
    `SELECT merchant_id AS mid FROM merchant_business_details WHERE business_id=? LIMIT 1`,
    `SELECT user_id AS mid FROM merchant_business_details WHERE business_id=? LIMIT 1`,
    `SELECT owner_id AS mid FROM merchant_business_details WHERE business_id=? LIMIT 1`,
    `SELECT merchant_user_id AS mid FROM merchant_business_details WHERE business_id=? LIMIT 1`,
    `SELECT owner_user_id AS mid FROM merchant_business_details WHERE business_id=? LIMIT 1`,
  ];

  for (const sql of sqlVariants) {
    try {
      const [rows] = await db.query(sql, [bid]);
      const mid = Number(rows?.[0]?.mid || 0);
      if (mid) return mid;
      return null;
    } catch (e) {
      if (String(e.code) === "ER_BAD_FIELD_ERROR") continue;
      if (String(e.code) === "ER_NO_SUCH_TABLE") continue;
      throw e;
    }
  }

  return null;
}

/* ==================== CONTROLLERS ==================== */

// POST /chat/conversations/order/:orderId
// Body preferred: { customer_id, business_id }  (merchant_id optional)
// ✅ Adds conversation to business inbox immediately so merchant can list by business_id
exports.getOrCreateConversationForOrder = async (req, res) => {
  try {
    const actor = getActorStrict(req);
    if (!actor) {
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });
    }

    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId required" });
    }

    let customerId = Number(req.body?.customer_id || 0) || null;
    const businessId = Number(req.body?.business_id || 0) || null;
    let merchantId = Number(req.body?.merchant_id || 0) || null;

    if (!customerId && actor.role === "CUSTOMER") customerId = actor.id;
    if (!merchantId && actor.role === "MERCHANT") merchantId = actor.id;

    if (!merchantId && businessId) {
      merchantId = await fetchMerchantIdByBusinessId(businessId);
    }

    const extraMembers = [];
    if (customerId) extraMembers.push(store.memberKey("CUSTOMER", customerId));
    if (merchantId) extraMembers.push(store.memberKey("MERCHANT", merchantId));

    const cid = await store.getOrCreateConversation(
      orderId,
      actor.role,
      actor.id,
      extraMembers,
    );

    // store meta
    await store.setConversationMeta(cid, { customerId, businessId });

    // ✅ ensure business inbox gets this conversation right away
    if (businessId) {
      await store.linkConversationToBusiness(cid, String(businessId), Date.now());
    }

    // enrich
    const [usersMap, bizMap] = await Promise.all([
      fetchUsersByIds(customerId ? [customerId] : []),
      fetchBusinessesByIds(businessId ? [businessId] : []),
    ]);

    const u = customerId ? usersMap.get(customerId) : null;
    const b = businessId ? bizMap.get(businessId) : null;

    const meta = {
      customerId,
      businessId,
      customerName: u?.name || "",
      merchantBusinessName: b?.business_name || "",
      customer_profile_image: u?.profile_image || "",
      merchant_business_logo: b?.business_logo || "",
    };

    await store.setConversationMeta(cid, {
      customerName: meta.customerName,
      merchantBusinessName: meta.merchantBusinessName,
      customerId,
      businessId,
    });

    return res.json({
      success: true,
      conversation_id: cid,
      order_id: orderId,
      meta,
    });
  } catch (e) {
    log("[chat] startChat ERROR:", e.message);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
};

// ✅ GET /chat/conversations
// CUSTOMER -> uses x-user-id
// MERCHANT -> uses x-business-id only
exports.listConversations = async (req, res) => {
  try {
    const role = String(req.headers["x-user-type"] || "").toUpperCase();

    // CUSTOMER: list by user inbox
    if (role === "CUSTOMER") {
      const actor = getCustomerActor(req);
      if (!actor) {
        return res
          .status(401)
          .json({ success: false, message: "Missing x-user-type=CUSTOMER / x-user-id" });
      }

      const rows = await store.listInbox("CUSTOMER", actor.id, { limit: 50 });

      // enrich for customer (optional)
      const bizIds = [...new Set(rows.map((r) => r.business_id).filter(Boolean))];
      const [bizMap] = await Promise.all([fetchBusinessesByIds(bizIds)]);

      const out = rows.map((r) => {
        const b = r.business_id ? bizMap.get(r.business_id) : null;
        return {
          ...r,
          merchant_business_name: b?.business_name || r.merchant_business_name || "",
          merchant_business_logo: b?.business_logo || "",
        };
      });

      return res.json({ success: true, rows: out });
    }

    // MERCHANT: list by business inbox (no x-user-id required)
    if (role === "MERCHANT") {
      const businessId = getMerchantBusinessId(req);
      if (!businessId) {
        return res
          .status(401)
          .json({ success: false, message: "Missing x-user-type=MERCHANT / x-business-id" });
      }

      const rows = await store.listBusinessInbox(String(businessId), { limit: 50 });

      // enrich: fetch customer names + business logo
      const userIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
      const bizIds = [...new Set(rows.map((r) => r.business_id).filter(Boolean))];

      const [usersMap, bizMap] = await Promise.all([
        fetchUsersByIds(userIds),
        fetchBusinessesByIds(bizIds),
      ]);

      const out = rows.map((r) => {
        const u = r.customer_id ? usersMap.get(r.customer_id) : null;
        const b = r.business_id ? bizMap.get(r.business_id) : null;

        return {
          ...r,
          customer_name: u?.name || r.customer_name || "",
          customer_profile_image: u?.profile_image || "",
          merchant_business_name: b?.business_name || r.merchant_business_name || "",
          merchant_business_logo: b?.business_logo || "",
        };
      });

      return res.json({ success: true, rows: out });
    }

    return res.status(401).json({ success: false, message: "Missing x-user-type" });
  } catch (e) {
    log("[chat] listConversations ERROR:", e.message);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
};

// GET /chat/messages/:conversationId  (unchanged; still strict membership by user)
exports.getMessages = async (req, res) => {
  try {
    const actor = getActorStrict(req);
    if (!actor) {
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });
    }

    const conversationId = String(req.params.conversationId || "");
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok) return res.status(403).json({ success: false, message: "Not allowed" });

    const businessIdHint =
      Number(req.headers["x-business-id"] || 0) ||
      Number(req.query.business_id || 0) ||
      null;

    const metaR = await store.getConversationMeta(conversationId);
    let customerId = metaR.customerId ? Number(metaR.customerId) : null;
    let businessId = metaR.businessId ? Number(metaR.businessId) : null;

    // backfill businessId if merchant provided it
    if (!businessId && actor.role === "MERCHANT" && businessIdHint) {
      businessId = businessIdHint;
      await store.setConversationMeta(conversationId, { businessId });
      await store.linkConversationToBusiness(conversationId, String(businessIdHint), Date.now());
    }

    const [usersMap, bizMap] = await Promise.all([
      fetchUsersByIds(customerId ? [customerId] : []),
      fetchBusinessesByIds(businessId ? [businessId] : []),
    ]);

    const u = customerId ? usersMap.get(customerId) : null;
    const b = businessId ? bizMap.get(businessId) : null;

    const meta = {
      customerId,
      businessId,
      customerName: u?.name || metaR.customerName || "",
      merchantBusinessName: b?.business_name || metaR.merchantBusinessName || "",
      customer_profile_image: u?.profile_image || "",
      merchant_business_logo: b?.business_logo || "",
    };

    const rows = await store.getMessages(conversationId, { limit, beforeId });
    return res.json({ success: true, meta, rows });
  } catch (e) {
    log("[chat] getMessages ERROR:", e.message);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
};

// POST /chat/messages/:conversationId (unchanged except: business inbox touch is handled in store.addMessage)
exports.sendMessage = async (req, res) => {
  try {
    const actor = getActorStrict(req);
    if (!actor) {
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });
    }

    const conversationId = String(req.params.conversationId || "");
    const text = String(req.body?.body || "").trim();
    const hasImage = !!req.file;

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok) return res.status(403).json({ success: false, message: "Not allowed" });

    if (!text && !hasImage) {
      return res
        .status(400)
        .json({ success: false, message: "body or chat_image required" });
    }

    let type = "TEXT";
    let mediaUrl = "";

    if (hasImage) {
      type = "IMAGE";
      mediaUrl = buildStoredMediaUrl(req, "chat_image", req.file.filename);
    }

    const { streamId, ts: tsMs } = await store.addMessage(conversationId, {
      senderRole: actor.role,
      senderId: actor.id,
      type,
      text,
      mediaUrl,
    });

    const message = {
      id: streamId,
      sender_type: actor.role,
      sender_id: actor.id,
      message_type: type,
      body: text || null,
      media_url: mediaUrl || null,
      ts: tsMs,
    };

    const io = req.app.get("io");
    if (io) {
      const room = `chat:conv:${conversationId}`;
      io.to(room).emit("chat:new_message", { conversationId, message });
    }

    return res.json({ success: true, message });
  } catch (e) {
    log("[chat] sendMessage ERROR:", e.message);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
};

// POST /chat/read/:conversationId (unchanged)
exports.markRead = async (req, res) => {
  try {
    const actor = getActorStrict(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const lastReadMessageId = String(req.body?.lastReadMessageId || "");

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok) return res.status(403).json({ success: false, message: "Not allowed" });

    await store.markRead(conversationId, actor.role, actor.id, lastReadMessageId);
    return res.json({ success: true });
  } catch (e) {
    log("[chat] markRead ERROR:", e.message);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
};
