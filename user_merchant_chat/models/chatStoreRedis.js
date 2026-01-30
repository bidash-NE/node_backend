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
};

const memberKey = (role, id) => `${role}:${id}`;

async function getOrCreateConversation(
  orderId,
  callerRole,
  callerId,
  extraMembers = [],
) {
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
    (await redis.sismember(
      K.members(conversationId),
      memberKey(role, userId),
    )) === 1
  );
}

async function setConversationMeta(conversationId, meta = {}) {
  const clean = {};

  if (meta.customerId != null && String(meta.customerId).trim())
    clean.customerId = String(meta.customerId).trim();
  if (meta.businessId != null && String(meta.businessId).trim())
    clean.businessId = String(meta.businessId).trim();

  if (typeof meta.customerName === "string" && meta.customerName.trim())
    clean.customerName = meta.customerName.trim();
  if (
    typeof meta.merchantBusinessName === "string" &&
    meta.merchantBusinessName.trim()
  )
    clean.merchantBusinessName = meta.merchantBusinessName.trim();

  if (Object.keys(clean).length) {
    await redis.hset(K.conv(conversationId), clean);
  }
}

async function getConversationMeta(conversationId) {
  return await redis.hgetall(K.conv(conversationId));
}

async function addMessage(
  conversationId,
  { senderRole, senderId, type, text, mediaUrl },
) {
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

  const lastText = type === "TEXT" ? text || "" : text ? text : "[image]";
  await redis.hset(K.conv(conversationId), {
    lastMsgAt: String(ts),
    lastMsgType: type,
    lastMsgText: lastText.slice(0, 120),
    lastMsgMedia: mediaUrl || "",
  });

  const members = await redis.smembers(K.members(conversationId));
  const multi = redis.multi();

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
  const rows = await redis.xrevrange(
    K.msgs(conversationId),
    end,
    "-",
    "COUNT",
    limit,
  );

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

// auto delete the chats when the order status == delivered
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

  const multi = redis.multi();

  for (const m of members) {
    const [role, id] = m.split(":");
    multi.zrem(K.inbox(role, id), cid);
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

// ✅ simple distributed lock so only 1 pod runs cleanup loop
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
  addMessage,
  getMessages,
  listInbox,
  markRead,
  getMembers,
  collectMediaUrls,
  deleteConversationByOrderId,
  wasOrderCleaned,
  markOrderCleaned,
  tryAcquireCleanupLock,
};
