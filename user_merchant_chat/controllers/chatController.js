// File: controllers/chatController.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Redis chat store remains unchanged
// ✅ CUSTOMER lists by x-user-id
// ✅ MERCHANT lists by x-business-id only

const { prisma } = require("../lib/prisma");

const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

function ts() {
  return new Date().toISOString();
}

function log(...a) {
  console.log(`[${ts()}]`, ...a);
}

function cleanStr(v) {
  return (v ?? "").toString().trim();
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toPositiveBigInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

/* ==================== ACTOR PARSERS ==================== */

// CUSTOMER must have x-user-id
function getCustomerActor(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();

  if (role !== "CUSTOMER") return null;

  const id = toPositiveNumber(req.headers["x-user-id"]);

  if (!id) return null;

  return {
    role: "CUSTOMER",
    id,
  };
}

// MERCHANT listing uses business_id only, no x-user-id required for list
function getMerchantBusinessId(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();

  if (role !== "MERCHANT") return null;

  const bid =
    toPositiveNumber(req.headers["x-business-id"]) ||
    toPositiveNumber(req.query.business_id) ||
    null;

  return bid ? String(bid) : null;
}

// For messages/read/create, keep strict actor check
function getActorStrict(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  const id = toPositiveNumber(req.headers["x-user-id"]);

  if (!["CUSTOMER", "MERCHANT"].includes(role) || !id) {
    return null;
  }

  return {
    role,
    id,
  };
}

/* ==================== MEDIA URL BUILDER ==================== */

function buildStoredMediaUrl(req, fieldname, filename) {
  const rel = upload.toWebPath(fieldname, filename);

  // Force chat images served under "/chat/uploads/..."
  let out = rel;

  if (fieldname === "chat_image") {
    out = `/chat${rel.startsWith("/") ? rel : `/${rel}`}`;
  }

  const base = (process.env.MEDIA_BASE_URL || "").trim().replace(/\/+$/, "");

  return base ? `${base}${out}` : out;
}

/* ==================== PRISMA FETCHERS ==================== */

async function fetchUsersByIds(userIds) {
  const ids = [
    ...new Set(
      (userIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await prisma.users.findMany({
      where: {
        user_id: {
          in: ids.map((id) => BigInt(id)),
        },
      },
      select: {
        user_id: true,
        user_name: true,
        profile_image: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);
      const uid = Number(r.user_id);

      map.set(uid, {
        name: cleanStr(r.user_name),
        profile_image: cleanStr(r.profile_image),
      });
    }
  } catch (e) {
    console.error("[chat] fetchUsersByIds ERROR:", e?.message || e);
  }

  return map;
}

async function fetchBusinessesByIds(businessIds) {
  const ids = [
    ...new Set(
      (businessIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await prisma.merchant_business_details.findMany({
      where: {
        business_id: {
          in: ids.map((id) => BigInt(id)),
        },
      },
      select: {
        business_id: true,
        business_name: true,
        business_logo: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);
      const bid = Number(r.business_id);

      map.set(bid, {
        business_name: cleanStr(r.business_name),
        business_logo: cleanStr(r.business_logo),
      });
    }
  } catch (e) {
    console.error("[chat] fetchBusinessesByIds ERROR:", e?.message || e);
  }

  return map;
}

/**
 * Derive merchant user_id from business_id.
 *
 * Your schema uses merchant_business_details.user_id.
 * This replaces the old SQL variants.
 */
async function fetchMerchantIdByBusinessId(businessId) {
  const bid = toPositiveBigInt(businessId);

  if (!bid) return null;

  try {
    const row = await prisma.merchant_business_details.findUnique({
      where: {
        business_id: bid,
      },
      select: {
        user_id: true,
      },
    });

    const merchantId = row?.user_id != null ? Number(row.user_id) : null;

    return Number.isFinite(merchantId) && merchantId > 0 ? merchantId : null;
  } catch (e) {
    console.error("[chat] fetchMerchantIdByBusinessId ERROR:", e?.message || e);
    return null;
  }
}

/* ==================== CONTROLLERS ==================== */

// POST /chat/conversations/order/:orderId
// Body preferred: { customer_id, business_id }  merchant_id optional
exports.getOrCreateConversationForOrder = async (req, res) => {
  try {
    const actor = getActorStrict(req);

    if (!actor) {
      return res.status(401).json({
        success: false,
        message: "Missing x-user-type / x-user-id",
      });
    }

    const orderId = String(req.params.orderId || "").trim();

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId required",
      });
    }

    let customerId = toPositiveNumber(req.body?.customer_id);
    const businessId = toPositiveNumber(req.body?.business_id);
    let merchantId = toPositiveNumber(req.body?.merchant_id);

    if (!customerId && actor.role === "CUSTOMER") {
      customerId = actor.id;
    }

    if (!merchantId && actor.role === "MERCHANT") {
      merchantId = actor.id;
    }

    if (!merchantId && businessId) {
      merchantId = await fetchMerchantIdByBusinessId(businessId);
    }

    const extraMembers = [];

    if (customerId) {
      extraMembers.push(store.memberKey("CUSTOMER", customerId));
    }

    if (merchantId) {
      extraMembers.push(store.memberKey("MERCHANT", merchantId));
    }

    const cid = await store.getOrCreateConversation(
      orderId,
      actor.role,
      actor.id,
      extraMembers,
    );

    // Store base meta
    await store.setConversationMeta(cid, {
      customerId,
      businessId,
    });

    // Ensure business inbox gets this conversation immediately
    if (businessId) {
      await store.linkConversationToBusiness(
        cid,
        String(businessId),
        Date.now(),
      );
    }

    // Enrich
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

    return res.status(500).json({
      success: false,
      message: e.message || "Server error",
    });
  }
};

// GET /chat/conversations
// CUSTOMER -> uses x-user-id
// MERCHANT -> uses x-business-id only
exports.listConversations = async (req, res) => {
  try {
    const role = String(req.headers["x-user-type"] || "").toUpperCase();

    // CUSTOMER: list by user inbox
    if (role === "CUSTOMER") {
      const actor = getCustomerActor(req);

      if (!actor) {
        return res.status(401).json({
          success: false,
          message: "Missing x-user-type=CUSTOMER / x-user-id",
        });
      }

      const rows = await store.listInbox("CUSTOMER", actor.id, {
        limit: 50,
      });

      const bizIds = [
        ...new Set(rows.map((r) => r.business_id).filter(Boolean)),
      ];

      const bizMap = await fetchBusinessesByIds(bizIds);

      const out = rows.map((r) => {
        const b = r.business_id ? bizMap.get(Number(r.business_id)) : null;

        return {
          ...r,
          merchant_business_name:
            b?.business_name || r.merchant_business_name || "",
          merchant_business_logo: b?.business_logo || "",
        };
      });

      return res.json({
        success: true,
        rows: out,
      });
    }

    // MERCHANT: list by business inbox, no x-user-id required
    if (role === "MERCHANT") {
      const businessId = getMerchantBusinessId(req);

      if (!businessId) {
        return res.status(401).json({
          success: false,
          message: "Missing x-user-type=MERCHANT / x-business-id",
        });
      }

      const rows = await store.listBusinessInbox(String(businessId), {
        limit: 50,
      });

      const userIds = [
        ...new Set(rows.map((r) => r.customer_id).filter(Boolean)),
      ];

      const bizIds = [
        ...new Set(rows.map((r) => r.business_id).filter(Boolean)),
      ];

      const [usersMap, bizMap] = await Promise.all([
        fetchUsersByIds(userIds),
        fetchBusinessesByIds(bizIds),
      ]);

      const out = rows.map((r) => {
        const u = r.customer_id ? usersMap.get(Number(r.customer_id)) : null;
        const b = r.business_id ? bizMap.get(Number(r.business_id)) : null;

        return {
          ...r,
          customer_name: u?.name || r.customer_name || "",
          customer_profile_image: u?.profile_image || "",
          merchant_business_name:
            b?.business_name || r.merchant_business_name || "",
          merchant_business_logo: b?.business_logo || "",
        };
      });

      return res.json({
        success: true,
        rows: out,
      });
    }

    return res.status(401).json({
      success: false,
      message: "Missing x-user-type",
    });
  } catch (e) {
    log("[chat] listConversations ERROR:", e.message);

    return res.status(500).json({
      success: false,
      message: e.message || "Server error",
    });
  }
};

// GET /chat/messages/:conversationId
exports.getMessages = async (req, res) => {
  try {
    const actor = getActorStrict(req);

    if (!actor) {
      return res.status(401).json({
        success: false,
        message: "Missing x-user-type / x-user-id",
      });
    }

    const conversationId = String(req.params.conversationId || "");
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;

    const ok = await store.isMember(conversationId, actor.role, actor.id);

    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const businessIdHint =
      toPositiveNumber(req.headers["x-business-id"]) ||
      toPositiveNumber(req.query.business_id) ||
      null;

    const metaR = await store.getConversationMeta(conversationId);

    let customerId = metaR.customerId ? Number(metaR.customerId) : null;
    let businessId = metaR.businessId ? Number(metaR.businessId) : null;

    // Backfill businessId if merchant provided it
    if (!businessId && actor.role === "MERCHANT" && businessIdHint) {
      businessId = businessIdHint;

      await store.setConversationMeta(conversationId, {
        businessId,
      });

      await store.linkConversationToBusiness(
        conversationId,
        String(businessIdHint),
        Date.now(),
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

    const rows = await store.getMessages(conversationId, {
      limit,
      beforeId,
    });

    return res.json({
      success: true,
      meta,
      rows,
    });
  } catch (e) {
    log("[chat] getMessages ERROR:", e.message);

    return res.status(500).json({
      success: false,
      message: e.message || "Server error",
    });
  }
};

// POST /chat/messages/:conversationId
exports.sendMessage = async (req, res) => {
  try {
    const actor = getActorStrict(req);

    if (!actor) {
      return res.status(401).json({
        success: false,
        message: "Missing x-user-type / x-user-id",
      });
    }

    const conversationId = String(req.params.conversationId || "");
    const text = String(req.body?.body || "").trim();
    const hasImage = !!req.file;

    const ok = await store.isMember(conversationId, actor.role, actor.id);

    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    if (!text && !hasImage) {
      return res.status(400).json({
        success: false,
        message: "body or chat_image required",
      });
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

      io.to(room).emit("chat:new_message", {
        conversationId,
        message,
      });
    }

    return res.json({
      success: true,
      message,
    });
  } catch (e) {
    log("[chat] sendMessage ERROR:", e.message);

    return res.status(500).json({
      success: false,
      message: e.message || "Server error",
    });
  }
};

// POST /chat/read/:conversationId
exports.markRead = async (req, res) => {
  try {
    const actor = getActorStrict(req);

    if (!actor) {
      return res.status(401).json({
        success: false,
        message: "Missing x-user-type / x-user-id",
      });
    }

    const conversationId = String(req.params.conversationId || "");
    const lastReadMessageId = String(req.body?.lastReadMessageId || "");

    const ok = await store.isMember(conversationId, actor.role, actor.id);

    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    await store.markRead(
      conversationId,
      actor.role,
      actor.id,
      lastReadMessageId,
    );

    return res.json({
      success: true,
    });
  } catch (e) {
    log("[chat] markRead ERROR:", e.message);

    return res.status(500).json({
      success: false,
      message: e.message || "Server error",
    });
  }
};