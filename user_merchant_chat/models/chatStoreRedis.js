const redis = require("../config/redis");

const K = {
  orderConv: (orderId) => `chat:order:${orderId}`, // order -> convId
  convId: () => `chat:conv:id`, // INCR
  conv: (cid) => `chat:conv:${cid}`, // HASH meta
  members: (cid) => `chat:conv:${cid}:members`, // SET of "ROLE:ID"
  msgs: (cid) => `chat:conv:${cid}:msgs`, // STREAM
  inbox: (role, uid) => `chat:user:${role}:${uid}:inbox`, // ZSET score=ts member=convId
  unread: (cid) => `chat:conv:${cid}:unread`, // HASH memberKey->count
  lastread: (cid) => `chat:conv:${cid}:lastread`, // HASH memberKey->streamId
};

const memberKey = (role, id) => `${role}:${id}`;

async function addMembers(conversationId, members = []) {
  if (!members.length) return;
  await redis.sadd(K.members(conversationId), ...members);
}

async function getOrCreateConversation(
  orderId,
  callerRole,
  callerId,
  extraMembers = [],
) {
  const existing = await redis.get(K.orderConv(orderId));
  if (existing) {
    await addMembers(existing, [
      memberKey(callerRole, callerId),
      ...extraMembers,
    ]);
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

module.exports = {
  memberKey,
  getOrCreateConversation,
  isMember,
  addMessage,
  getMessages,
  listInbox,
  markRead,
};
