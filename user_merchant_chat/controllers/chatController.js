const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

// Local dev auth (TEMP): send headers from app/curl
// x-user-type: CUSTOMER | MERCHANT
// x-user-id: 58
function getActor(req) {
  const role = String(req.headers["x-user-type"] || "").toUpperCase();
  const id = Number(req.headers["x-user-id"] || 0);
  if (!["CUSTOMER", "MERCHANT"].includes(role) || !id) return null;
  return { role, id };
}

// Optional: store full URL if MEDIA_BASE_URL exists, else store relative /uploads/...
function buildStoredMediaUrl(req, fieldname, filename) {
  const rel = upload.toWebPath(fieldname, filename); // /uploads/chat/...
  const base = process.env.MEDIA_BASE_URL || "";
  if (base) return `${base}${rel}`;
  // if no MEDIA_BASE_URL, keep relative (client can prepend)
  return rel;
}

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

    // OPTIONAL: pass other participant ids while testing locally
    // body: { customer_id: 58, merchant_id: 12 }
    const extraMembers = [];
    const cId = Number(req.body?.customer_id || 0);
    const mId = Number(req.body?.merchant_id || 0);
    if (cId) extraMembers.push(store.memberKey("CUSTOMER", cId));
    if (mId) extraMembers.push(store.memberKey("MERCHANT", mId));

    const cid = await store.getOrCreateConversation(
      orderId,
      actor.role,
      actor.id,
      extraMembers,
    );
    return res.json({ success: true, conversation_id: cid, order_id: orderId });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

exports.listConversations = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const rows = await store.listInbox(actor.role, actor.id, { limit: 50 });
    return res.json({ success: true, rows });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok)
      return res.status(403).json({ success: false, message: "Not allowed" });

    const limit = Math.min(Number(req.query.limit || 30), 100);
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;

    const rows = await store.getMessages(conversationId, { limit, beforeId });
    return res.json({ success: true, rows });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok)
      return res.status(403).json({ success: false, message: "Not allowed" });

    const text = String(req.body?.body || "").trim();
    const hasImage = !!req.file;

    if (!text && !hasImage) {
      return res
        .status(400)
        .json({ success: false, message: "body or chat_image required" });
    }

    const type = hasImage ? "IMAGE" : "TEXT";
    const mediaUrl = hasImage
      ? buildStoredMediaUrl(req, "chat_image", req.file.filename)
      : "";

    const { streamId, ts } = await store.addMessage(conversationId, {
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
      ts,
    };

    const io = req.app.get("io");
    if (io)
      io.to(`chat:conv:${conversationId}`).emit("chat:new_message", {
        conversationId,
        message,
      });

    return res.json({ success: true, message });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};

exports.markRead = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor)
      return res
        .status(401)
        .json({ success: false, message: "Missing x-user-type / x-user-id" });

    const conversationId = String(req.params.conversationId || "");
    const ok = await store.isMember(conversationId, actor.role, actor.id);
    if (!ok)
      return res.status(403).json({ success: false, message: "Not allowed" });

    const lastReadMessageId = String(req.body?.lastReadMessageId || "");
    await store.markRead(
      conversationId,
      actor.role,
      actor.id,
      lastReadMessageId,
    );

    return res.json({ success: true });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Server error" });
  }
};
