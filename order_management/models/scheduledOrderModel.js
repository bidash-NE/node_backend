const redis = require("../config/redis");

const ZSET_KEY = "scheduled_orders";
const COUNTER_KEY = "scheduled_order_counter";

/* ===================== Helpers ===================== */

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

/* ===================== Core Model ===================== */

async function addScheduledOrder(scheduledAt, orderPayload, userId) {
  const jobId = await generateScheduledId();
  const now = new Date();

  // still parse it to compute the score for ZSET
  const scheduledDate =
    scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  const score = scheduledDate.getTime();

  const payload = {
    job_id: jobId,
    user_id: userId,

    // 👇 keep EXACT same string that came from JSON (Bhutan time)
    scheduled_at:
      typeof scheduledAt === "string"
        ? scheduledAt
        : scheduledDate.toISOString(),

    // if you want Bhutan time string for created_at, you can change this too
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
  jobIds.forEach((jobId) => {
    pipeline.get(buildJobKey(jobId));
  });

  const results = await pipeline.exec();

  const list = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data.user_id === userId) {
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

/* ===================== Exports ===================== */

module.exports = {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
};
