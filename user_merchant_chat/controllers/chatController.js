// File: controllers/chatController.js
// ✅ users.user_id + users.profile_image
// ✅ merchant_business_details.business_id + business_logo
// ✅ business id hint: x-business-id OR ?business_id=
// ✅ emits live socket event chat:new_message to room chat:conv:<conversationId>

const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

// Robust db import (supports module.exports = pool OR { pool })
const dbMod = require("../config/db");
const db =
  (dbMod && typeof dbMod.query === "function" && dbMod) ||
  (dbMod &&
    dbMod.pool &&
    typeof dbMod.pool.query === "function" &&
    dbMod.pool) ||
  null;

if (!db) {
  console.error("[DB] Invalid export from config/db.js ->", dbMod);
  throw new Error(
    "DB pool not initialized. config/db.js must export mysql pool.",
  );
}

function ts() {
  return new Date().toISOString();
}
function log(...a) {
  console.log(`[${ts()}]`, ...a);
}

function getActor(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  const id = Number(req.headers["x-user-id"] || 0);
  if (!["CUSTOMER", "MERCHANT"].includes(role) || !id) return null;
  return { role, id };
}

function buildStoredMediaUrl(req, fieldname, filename) {
  const rel = upload.toWebPath(fieldname, filename); // /uploads/chat/...
  const base = process.env.MEDIA_BASE_URL || "";
  return base ? `${base}${rel}` : rel;
}

function cleanStr(v) {
  return (v ?? "").toString().trim();
}

/* ---------------- DB fetchers ---------------- */

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
    const name = cleanStr(r.display_name);
    const profile_image = cleanStr(r.profile_image);
    log(
      `[db] users.user_id=${uid} name="${name}" profile_image="${profile_image}"`,
    );
    map.set(uid, { name, profile_image });
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
    const business_name = cleanStr(r.business_name);
    const business_logo = cleanStr(r.business_logo);
    log(
      `[db] business_id=${bid} business_name="${business_name}" business_logo="${business_logo}"`,
    );
    map.set(bid, { business_name, business_logo });
  }
  return map;
}

/* ---------------- controllers ---------------- */

// POST /chat/conversations/order/:orderId
// Body: { customer_id, merchant_id, business_id }
exports.getOrCreateConversationForOrder = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const orderId = String(req.params.orderId || "").trim();
    if (!orderId)
      return res
        .status(400)
        .json({ success: false, message: "orderId required" });

    const customerId = Number(req.body?.customer_id || 0) || null;
    const merchantId = Number(req.body?.merchant_id || 0) || null;
    const businessId = Number(req.body?.business_id || 0) || null;

    log("[chat] startChat", {
      actor,
      orderId,
      customerId,
      merchantId,
      businessId,
    });

    const extraMembers = [];
    if (customerId) extraMembers.push(store.memberKey("CUSTOMER", customerId));
    if (merchantId) extraMembers.push(store.memberKey("MERCHANT", merchantId));

    const cid = await store.getOrCreateConversation(
      orderId,
      actor.role,
      actor.id,
      extraMembers,
    );

    await store.setConversationMeta(cid, { customerId, businessId });

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

    log("[chat] startChat meta return =", meta);

    return res.json({
      success: true,
      conversation_id: cid,
      order_id: orderId,
      meta,
    });
  } catch (e) {
    log("[chat] startChat ERROR:", e.message);
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

// GET /chat/conversations
exports.listConversations = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const businessIdHint =
      Number(req.headers["x-business-id"] || 0) ||
      Number(req.query.business_id || 0) ||
      null;

    log(
      "[chat] listConversations actor=",
      actor,
      "businessIdHint=",
      businessIdHint,
    );

    const rows = await store.listInbox(actor.role, actor.id, { limit: 50 });

    // If MERCHANT passes business_id and some convs don't have it yet, backfill it now
    if (actor.role === "MERCHANT" && businessIdHint) {
      for (const r of rows) {
        if (!r.business_id) {
          r.business_id = businessIdHint;
          await store.setConversationMeta(r.conversation_id, {
            businessId: businessIdHint,
          });
          log(
            `[chat] backfilled conv=${r.conversation_id} business_id=${businessIdHint}`,
          );
        }
      }
    }

    const userIds = [
      ...new Set(rows.map((r) => r.customer_id).filter(Boolean)),
    ];
    const bizIds = [...new Set(rows.map((r) => r.business_id).filter(Boolean))];

    log(
      "[chat] listConversations will fetch userIds=",
      userIds,
      "bizIds=",
      bizIds,
    );

    const [usersMap, bizMap] = await Promise.all([
      fetchUsersByIds(userIds),
      fetchBusinessesByIds(bizIds),
    ]);

    const out = rows.map((r) => {
      const u = r.customer_id ? usersMap.get(r.customer_id) : null;
      const b = r.business_id ? bizMap.get(r.business_id) : null;

      const item = {
        ...r,
        customer_name: u?.name || r.customer_name || "",
        merchant_business_name:
          b?.business_name || r.merchant_business_name || "",
        customer_profile_image: u?.profile_image || "",
        merchant_business_logo: b?.business_logo || "",
      };

      log(
        `[chat] inbox conv=${item.conversation_id} business_id=${item.business_id || ""} customer_profile_image="${item.customer_profile_image}" merchant_business_logo="${item.merchant_business_logo}"`,
      );

      return item;
    });

    return res.json({ success: true, rows: out });
  } catch (e) {
    log("[chat] listConversations ERROR:", e.message);
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

// GET /chat/messages/:conversationId
exports.getMessages = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor) {
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });
    }

    const conversationId = String(req.params.conversationId || "");
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const businessIdHint =
      Number(req.headers["x-business-id"] || 0) ||
      Number(req.query.business_id || 0) ||
      null;

    const metaR = await store.getConversationMeta(conversationId);
    let customerId = metaR.customerId ? Number(metaR.customerId) : null;
    let businessId = metaR.businessId ? Number(metaR.businessId) : null;

    log(
      `[chat] getMessages conv=${conversationId} meta businessId=${businessId || ""} hint=${businessIdHint || ""}`,
    );

    if (!businessId && actor.role === "MERCHANT" && businessIdHint) {
      businessId = businessIdHint;
      await store.setConversationMeta(conversationId, { businessId });
      log(
        `[chat] getMessages backfilled businessId=${businessIdHint} for conv=${conversationId}`,
      );
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
      merchantBusinessName:
        b?.business_name || metaR.merchantBusinessName || "",
      customer_profile_image: u?.profile_image || "",
      merchant_business_logo: b?.business_logo || "",
    };

    log(
      `[chat] getMessages conv=${conversationId} customer_profile_image="${meta.customer_profile_image}" merchant_business_logo="${meta.merchant_business_logo}"`,
    );

    const rows = await store.getMessages(conversationId, { limit, beforeId });

    return res.json({ success: true, meta, rows });
  } catch (e) {
    log("[chat] getMessages ERROR:", e.message);
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

// POST /chat/messages/:conversationId
exports.sendMessage = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const text = String(req.body?.body || "").trim();
    const hasImage = !!req.file;

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok)
      return res.status(403).json({ success: false, message: "Not allowed" });

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
      log(
        `[chat] uploaded chat_image path="${req.file.path}" media_url="${mediaUrl}"`,
      );
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
    log("[chat] io exists?", !!io);

    if (io) {
      const room = `chat:conv:${conversationId}`;
      log("[chat] emitting chat:new_message to", room);
      io.to(room).emit("chat:new_message", { conversationId, message });
    }

    return res.json({ success: true, message });
  } catch (e) {
    log("[chat] sendMessage ERROR:", e.message);
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

// POST /chat/read/:conversationId
exports.markRead = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const lastReadMessageId = String(req.body?.lastReadMessageId || "");

    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok)
      return res.status(403).json({ success: false, message: "Not allowed" });

    await store.markRead(
      conversationId,
      actor.role,
      actor.id,
      lastReadMessageId,
    );
    return res.json({ success: true });
  } catch (e) {
    log("[chat] markRead ERROR:", e.message);
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};
