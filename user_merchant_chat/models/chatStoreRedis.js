// File: models/chatStoreRedis.js
const redis = require("../config/redis");

const K = {
  orderConv: (orderId) => `chat:order:${orderId}`,
  convId: () => `chat:conv:id`,
  conv: (cid) => `chat:conv:${cid}`,
  members: (cid) => `chat:conv:${cid}:members`,
  msgs: (cid) => `chat:conv:${cid}:msgs`,
  inbox: (role, uid) => `chat:user:${role}:${uid}:inbox`,
  unread: (cid) => `chat:conv:${cid}:unread`,
  lastread: (cid) => `chat:conv:${cid}:lastread`,
  hiddenMsgs: (cid, member) => `chat:conv:${cid}:hidden:${member}`,

  // ✅ NEW: business inbox (merchant list uses this)
  bizInbox: (businessId) => `chat:business:${businessId}:inbox`,
};

const memberKey = (role, id) => `${role}:${id}`;

/* ===================== conversation ===================== */

async function getOrCreateConversation(orderId, callerRole, callerId, extraMembers = []) {
  const existing = await redis.get(K.orderConv(orderId));
  if (existing) {
    await redis.sadd(
      K.members(existing),
      memberKey(callerRole, callerId),
      ...extraMembers,
    );
    return existing;
  }

  const cid = String(await redis.incr(K.convId()));
  const now = Date.now();

  const multi = redis.multi();
  multi.set(K.orderConv(orderId), cid);
  multi.hset(K.conv(cid), {
    orderId,
    createdAt: String(now),
    lastMsgAt: "0",
    lastMsgType: "",
    lastMsgText: "",
    lastMsgMedia: "",
    customerName: "",
    merchantBusinessName: "",
    customerId: "",
    businessId: "",
  });
  multi.sadd(K.members(cid), memberKey(callerRole, callerId), ...extraMembers);
  await multi.exec();

  return cid;
}

async function isMember(conversationId, role, userId) {
  return (
    (await redis.sismember(K.members(conversationId), memberKey(role, userId))) === 1
  );
}

/**
 * ✅ NEW: link a conversation into the business inbox (ZSET)
 * score should be a timestamp so newest is on top.
 */
async function linkConversationToBusiness(conversationId, businessId, scoreTs = Date.now()) {
  const bid = String(businessId || "").trim();
  if (!bid) return;
  await redis.zadd(K.bizInbox(bid), Number(scoreTs || Date.now()), String(conversationId));
}

async function setConversationMeta(conversationId, meta = {}) {
  const clean = {};

  if (meta.customerId != null && String(meta.customerId).trim())
    clean.customerId = String(meta.customerId).trim();
  if (meta.businessId != null && String(meta.businessId).trim())
    clean.businessId = String(meta.businessId).trim();

  if (typeof meta.customerName === "string" && meta.customerName.trim())
    clean.customerName = meta.customerName.trim();
  if (typeof meta.merchantBusinessName === "string" && meta.merchantBusinessName.trim())
    clean.merchantBusinessName = meta.merchantBusinessName.trim();

  if (Object.keys(clean).length) {
    await redis.hset(K.conv(conversationId), clean);
  }

  // ✅ If businessId is being set, ensure business inbox contains this conversation
  if (clean.businessId) {
    await linkConversationToBusiness(conversationId, clean.businessId, Date.now());
  }
}

async function getConversationMeta(conversationId) {
  return await redis.hgetall(K.conv(conversationId));
}

/* ===================== messages ===================== */

async function addMessage(conversationId, { senderRole, senderId, type, text, mediaUrl }) {
  const ts = Date.now();

  const streamId = await redis.xadd(
    K.msgs(conversationId),
    "*",
    "senderType",
    senderRole,
    "senderId",
    String(senderId),
    "type",
    type,
    "text",
    text || "",
    "mediaUrl",
    mediaUrl || "",
    "ts",
    String(ts),
  );

  const mediaFallback = type === "VOICE" ? "[voice message]" : "[image]";
  const lastText =
    type === "TEXT" ? (text || "") : text ? text : mediaFallback;
  await redis.hset(K.conv(conversationId), {
    lastMsgAt: String(ts),
    lastMsgType: type,
    lastMsgText: lastText.slice(0, 120),
    lastMsgMedia: mediaUrl || "",
  });

  // ✅ NEW: keep business inbox ordering up to date based on last message time
  const meta = await redis.hgetall(K.conv(conversationId));
  const businessId = meta?.businessId ? String(meta.businessId).trim() : "";
  if (businessId) {
    await linkConversationToBusiness(conversationId, businessId, ts);
  }

  const members = await redis.smembers(K.members(conversationId));
  const multi = redis.multi();

  // existing per-user inbox/unread logic
  for (const m of members) {
    const [mRole, mId] = m.split(":");
    multi.zadd(K.inbox(mRole, mId), ts, conversationId);

    if (!(mRole === senderRole && String(mId) === String(senderId))) {
      multi.hincrby(K.unread(conversationId), m, 1);
    }
  }

  await multi.exec();
  return { streamId, ts };
}

async function getMessages(conversationId, { limit = 30, beforeId = null }) {
  const end = beforeId ? beforeId : "+";
  const rows = await redis.xrevrange(K.msgs(conversationId), end, "-", "COUNT", limit);

  // NOTE: xrevrange returns newest-first; client sorts if needed
  return rows.map(([id, arr]) => {
    const o = {};
    for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
    return {
      id,
      sender_type: o.senderType,
      sender_id: Number(o.senderId),
      message_type: o.type,
      body: o.text || null,
      media_url: o.mediaUrl || null,
      ts: Number(o.ts),
    };
  });
}

function deserializeMessage([id, arr]) {
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return {
    id,
    sender_type: o.senderType,
    sender_id: Number(o.senderId),
    message_type: o.type,
    body: o.text || null,
    media_url: o.mediaUrl || null,
    ts: Number(o.ts),
  };
}

async function getMessageById(conversationId, messageId) {
  const rows = await redis.xrange(
    K.msgs(conversationId),
    String(messageId),
    String(messageId),
  );
  return rows.length ? deserializeMessage(rows[0]) : null;
}

async function filterHiddenMessages(conversationId, role, userId, messages) {
  if (!messages.length) return messages;
  const key = K.hiddenMsgs(conversationId, memberKey(role, userId));
  const multi = redis.multi();
  for (const message of messages) multi.sismember(key, message.id);
  const results = await multi.exec();
  return messages.filter((_, index) => Number(results[index]?.[1] || 0) !== 1);
}

async function hideMessageForMember(conversationId, role, userId, messageId) {
  await redis.sadd(
    K.hiddenMsgs(conversationId, memberKey(role, userId)),
    String(messageId),
  );
}

async function refreshLastMessage(conversationId) {
  const rows = await redis.xrevrange(K.msgs(conversationId), "+", "-", "COUNT", 1);
  const meta = await redis.hgetall(K.conv(conversationId));
  const members = await redis.smembers(K.members(conversationId));
  let lastMsgAt = Number(meta.createdAt || 0);
  let lastMsgType = "";
  let lastMsgText = "";
  let lastMsgMedia = "";

  if (rows.length) {
    const message = deserializeMessage(rows[0]);
    lastMsgAt = message.ts;
    lastMsgType = message.message_type;
    lastMsgMedia = message.media_url || "";
    lastMsgText =
      message.body ||
      (message.message_type === "VOICE" ? "[voice message]" : "[image]");
  }

  const multi = redis.multi();
  multi.hset(K.conv(conversationId), {
    lastMsgAt: String(lastMsgAt),
    lastMsgType,
    lastMsgText: lastMsgText.slice(0, 120),
    lastMsgMedia,
  });

  const inboxLookup = redis.multi();
  for (const member of members) {
    const [role, id] = member.split(":");
    inboxLookup.zscore(K.inbox(role, id), conversationId);
  }
  if (meta.businessId) {
    inboxLookup.zscore(K.bizInbox(meta.businessId), conversationId);
  }
  const inboxResults = await inboxLookup.exec();

  for (let index = 0; index < members.length; index++) {
    if (inboxResults[index]?.[1] == null) continue;
    const [role, id] = members[index].split(":");
    multi.zadd(K.inbox(role, id), lastMsgAt, conversationId);
  }
  if (
    meta.businessId &&
    inboxResults[members.length]?.[1] != null
  ) {
    multi.zadd(K.bizInbox(meta.businessId), lastMsgAt, conversationId);
  }
  await multi.exec();
}

async function deleteMessageForEveryone(conversationId, messageId) {
  const deleted = await redis.xdel(K.msgs(conversationId), String(messageId));
  if (Number(deleted) > 0) await refreshLastMessage(conversationId);
  return Number(deleted) > 0;
}

async function deleteConversationForMember(conversationId, role, userId) {
  const member = memberKey(role, userId);
  const rows = await redis.xrange(K.msgs(conversationId), "-", "+");
  const meta = await redis.hgetall(K.conv(conversationId));
  const multi = redis.multi();

  if (rows.length) {
    multi.sadd(K.hiddenMsgs(conversationId, member), ...rows.map(([id]) => id));
  }
  multi.zrem(K.inbox(role, userId), conversationId);
  multi.hset(K.unread(conversationId), member, 0);
  multi.hdel(K.lastread(conversationId), member);
  if (role === "MERCHANT" && meta.businessId) {
    multi.zrem(K.bizInbox(meta.businessId), conversationId);
  }
  await multi.exec();
  return { hidden_message_count: rows.length };
}

async function listInbox(role, userId, { limit = 50 } = {}) {
  const ids = await redis.zrevrange(K.inbox(role, userId), 0, limit - 1);
  if (!ids.length) return [];

  const me = memberKey(role, userId);
  const multi = redis.multi();

  for (const cid of ids) {
    multi.hgetall(K.conv(cid));
    multi.hget(K.unread(cid), me);
  }

  const res = await multi.exec();
  const out = [];

  for (let i = 0; i < ids.length; i++) {
    const meta = res[i * 2]?.[1] || {};
    const unread = Number(res[i * 2 + 1]?.[1] || 0);

    out.push({
      conversation_id: ids[i],
      order_id: meta.orderId || "",
      last_message_at: Number(meta.lastMsgAt || 0),
      last_message_type: meta.lastMsgType || "",
      last_message_body: meta.lastMsgText || "",
      last_message_media_url: meta.lastMsgMedia || "",
      unread_count: unread,

      customer_id: meta.customerId ? Number(meta.customerId) : null,
      business_id: meta.businessId ? Number(meta.businessId) : null,

      customer_name: meta.customerName || "",
      merchant_business_name: meta.merchantBusinessName || "",
    });
  }

  return out;
}

/**
 * ✅ NEW: list conversations for a business (merchant list)
 * Uses ZSET chat:business:<businessId>:inbox
 */
async function listBusinessInbox(businessId, { limit = 50 } = {}) {
  const bid = String(businessId || "").trim();
  if (!bid) return [];

  const ids = await redis.zrevrange(K.bizInbox(bid), 0, limit - 1);
  if (!ids.length) return [];

  const multi = redis.multi();
  for (const cid of ids) {
    multi.hgetall(K.conv(cid));
  }
  const res = await multi.exec();

  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const meta = res[i]?.[1] || {};

    out.push({
      conversation_id: ids[i],
      order_id: meta.orderId || "",
      last_message_at: Number(meta.lastMsgAt || 0),
      last_message_type: meta.lastMsgType || "",
      last_message_body: meta.lastMsgText || "",
      last_message_media_url: meta.lastMsgMedia || "",

      // business-level list cannot know “per merchant user unread”
      // your UI can hide badge or show 0
      unread_count: 0,

      customer_id: meta.customerId ? Number(meta.customerId) : null,
      business_id: meta.businessId ? Number(meta.businessId) : null,

      customer_name: meta.customerName || "",
      merchant_business_name: meta.merchantBusinessName || "",
    });
  }

  return out;
}

async function markRead(conversationId, role, userId, lastReadStreamId) {
  const me = memberKey(role, userId);
  const multi = redis.multi();
  multi.hset(K.lastread(conversationId), me, lastReadStreamId || "");
  multi.hset(K.unread(conversationId), me, 0);
  await multi.exec();
}

async function getMembers(conversationId) {
  return await redis.smembers(K.members(conversationId));
}

/* ===================== cleanup (kept as your original) ===================== */

async function collectMediaUrls(conversationId) {
  const key = K.msgs(conversationId);
  const media = [];
  const COUNT = 500;

  let start = "-";
  const end = "+";

  while (true) {
    const rows = await redis.xrange(key, start, end, "COUNT", COUNT);
    if (!rows.length) break;

    for (const [id, arr] of rows) {
      for (let i = 0; i < arr.length; i += 2) {
        if (arr[i] === "mediaUrl" && arr[i + 1]) media.push(arr[i + 1]);
      }
      start = id;
    }

    start = "(" + start;
    if (rows.length < COUNT) break;
  }

  return media;
}

async function deleteConversationByOrderId(orderId, { deleteFiles } = {}) {
  const cid = await redis.get(K.orderConv(orderId));
  if (!cid)
    return { deleted: false, orderId, message: "No conversation for orderId" };

  const members = await redis.smembers(K.members(cid));
  const mediaUrls = await collectMediaUrls(cid);

  if (typeof deleteFiles === "function") {
    await deleteFiles(mediaUrls);
  }

  const meta = await redis.hgetall(K.conv(cid));
  const businessId = meta?.businessId ? String(meta.businessId).trim() : "";

  const multi = redis.multi();

  for (const m of members) {
    const [role, id] = m.split(":");
    multi.zrem(K.inbox(role, id), cid);
    multi.del(K.hiddenMsgs(cid, m));
  }

  // ✅ remove from business inbox too
  if (businessId) {
    multi.zrem(K.bizInbox(businessId), cid);
  }

  multi.del(K.msgs(cid));
  multi.del(K.members(cid));
  multi.del(K.conv(cid));
  multi.del(K.unread(cid));
  multi.del(K.lastread(cid));
  multi.del(K.orderConv(orderId));

  await multi.exec();

  return {
    deleted: true,
    orderId,
    conversationId: cid,
    mediaCount: mediaUrls.length,
  };
}

async function wasOrderCleaned(orderId) {
  return (await redis.get(`chat:cleanup:done:${orderId}`)) === "1";
}

async function markOrderCleaned(orderId, ttlSeconds = 60 * 60 * 24 * 30) {
  await redis.set(`chat:cleanup:done:${orderId}`, "1", "EX", ttlSeconds);
}

async function tryAcquireCleanupLock(ttlSeconds = 25) {
  const key = "chat:cleanup:lock";
  const ok = await redis.set(key, "1", "NX", "EX", ttlSeconds);
  return ok === "OK";
}

module.exports = {
  memberKey,

  getOrCreateConversation,
  isMember,
  setConversationMeta,
  getConversationMeta,

  // messages
  addMessage,
  getMessages,
  getMessageById,
  filterHiddenMessages,
  hideMessageForMember,
  deleteMessageForEveryone,
  deleteConversationForMember,

  // inboxes
  listInbox,
  listBusinessInbox,
  linkConversationToBusiness,

  // reads
  markRead,

  // misc
  getMembers,

  // cleanup
  collectMediaUrls,
  deleteConversationByOrderId,
  wasOrderCleaned,
  markOrderCleaned,
  tryAcquireCleanupLock,
};
