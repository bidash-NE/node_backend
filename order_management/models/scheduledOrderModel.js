// models/scheduledOrderModel.js
const redis = require("../config/redis");

const ZSET_KEY = "scheduled_orders";
const COUNTER_KEY = "scheduled_order_counter";

async function generateScheduledId() {
  const counter = await redis.incr(COUNTER_KEY);
  const padded = String(counter).padStart(6, "0");
  return `SCH-${padded}`;
}

function buildJobKey(jobId) {
  return `scheduled_order:${jobId}`;
}

function buildLockKey(jobId) {
  return `scheduled_order_lock:${jobId}`;
}

function extractBusinessIdFromJob(data) {
  if (!data) return null;

  let rawBizId =
    data.business_id ??
    data.order_payload?.business_id ??
    data.order_payload?.businessId ??
    data.order_payload?.business?.business_id ??
    null;

  if (
    rawBizId == null &&
    data.order_payload &&
    Array.isArray(data.order_payload.items) &&
    data.order_payload.items.length
  ) {
    const first = data.order_payload.items[0] || {};
    rawBizId =
      first.business_id ?? first.businessId ?? first.business?.business_id ?? null;
  }

  if (rawBizId == null) return null;

  const n = Number(rawBizId);
  if (Number.isNaN(n)) return null;
  return n;
}

async function addScheduledOrder(scheduledAt, orderPayload, userId) {
  const jobId = await generateScheduledId();
  const now = new Date();

  const scheduledDate =
    scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  const score = scheduledDate.getTime();

  const tmpData = { order_payload: orderPayload };
  const businessId = extractBusinessIdFromJob(tmpData);

  const payload = {
    job_id: jobId,
    user_id: userId,
    business_id: businessId ?? null,

    scheduled_at:
      typeof scheduledAt === "string" ? scheduledAt : scheduledDate.toISOString(),

    created_at: now.toISOString(),

    order_payload: {
      user_id: userId,
      ...orderPayload,
      status: "PENDING",
    },
  };

  const jobKey = buildJobKey(jobId);

  await redis
    .multi()
    .set(jobKey, JSON.stringify(payload))
    .zadd(ZSET_KEY, score, jobId)
    .exec();

  return payload;
}

async function getScheduledOrdersByUser(userId) {
  const nowTs = Date.now();

  const jobIds = await redis.zrangebyscore(
    ZSET_KEY,
    nowTs,
    "+inf",
    "LIMIT",
    0,
    100
  );

  if (!jobIds.length) return [];

  const pipeline = redis.pipeline();
  jobIds.forEach((jobId) => pipeline.get(buildJobKey(jobId)));

  const results = await pipeline.exec();

  const list = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data.user_id === userId) {
        if (!data.business_id) {
          const bizId = extractBusinessIdFromJob(data);
          if (bizId != null) data.business_id = bizId;
        }
        list.push(data);
      }
    } catch {}
  }

  list.sort(
    (a, b) =>
      new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
  );

  return list;
}

async function getScheduledOrdersByBusiness(businessId) {
  const nowTs = Date.now();

  const jobIds = await redis.zrangebyscore(
    ZSET_KEY,
    nowTs,
    "+inf",
    "LIMIT",
    0,
    100
  );

  if (!jobIds.length) return [];

  const pipeline = redis.pipeline();
  jobIds.forEach((jobId) => pipeline.get(buildJobKey(jobId)));

  const results = await pipeline.exec();

  const list = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try {
      const data = JSON.parse(raw);
      const jobBizId = extractBusinessIdFromJob(data);
      if (jobBizId === businessId) {
        data.business_id = jobBizId;
        list.push(data);
      }
    } catch {}
  }

  list.sort(
    (a, b) =>
      new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
  );

  return list;
}

async function cancelScheduledOrderForUser(jobId, userId) {
  const jobKey = buildJobKey(jobId);
  const raw = await redis.get(jobKey);
  if (!raw) return false;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }

  if (data.user_id !== userId) return false;

  await redis
    .multi()
    .del(jobKey)
    .zrem(ZSET_KEY, jobId)
    .del(buildLockKey(jobId))
    .exec();

  return true;
}

module.exports = {
  addScheduledOrder,
  getScheduledOrdersByUser,
  getScheduledOrdersByBusiness,
  cancelScheduledOrderForUser,
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
};
