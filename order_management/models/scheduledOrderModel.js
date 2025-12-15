// models/scheduledOrderModel.js
const redis = require("../config/redis");

const ZSET_KEY = "scheduled_orders";
const COUNTER_KEY = "scheduled_order_counter";

// Bhutan is UTC+6 (no DST)
const BHUTAN_OFFSET_MINUTES = 6 * 60;

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

/**
 * If input has timezone info (Z or +06:00 etc) => Date.parse is fine.
 * If input has NO timezone => treat as BHUTAN LOCAL TIME.
 */
function parseScheduledToEpochMs(input) {
  if (!input) return NaN;

  // Date object
  if (input instanceof Date) {
    return input.getTime();
  }

  // number (epoch ms)
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : NaN;
  }

  const s = String(input).trim();
  if (!s) return NaN;

  // If it includes timezone (Z or +hh:mm or -hh:mm), use native parse
  const hasTZ = /([zZ]|[+\-]\d{2}:\d{2})$/.test(s);
  if (hasTZ) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }

  // Otherwise treat as Bhutan local: "YYYY-MM-DDTHH:mm[:ss]" or "YYYY-MM-DD HH:mm[:ss]"
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return NaN;

  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] != null ? Number(m[6]) : 0;

  // Convert Bhutan local => UTC epoch
  // UTC time = local time - 6 hours
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const epochMs = utcMs - BHUTAN_OFFSET_MINUTES * 60 * 1000;

  return epochMs;
}

/**
 * Build a Bhutan-local ISO-like string with +06:00 from epochMs
 */
function epochToBhutanIso(epochMs) {
  // shift to local by adding +6 hours, then format with UTC getters
  const d = new Date(epochMs + BHUTAN_OFFSET_MINUTES * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");

  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+06:00`;
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
      first.business_id ??
      first.businessId ??
      first.business?.business_id ??
      null;
  }

  if (rawBizId == null) return null;

  const n = Number(rawBizId);
  if (Number.isNaN(n)) return null;
  return n;
}

/**
 * ✅ Stores:
 * - scheduled_at (UTC ISO) for machine
 * - scheduled_at_local (+06:00) for display
 * - score uses epochMs (Bhutan-correct)
 */
async function addScheduledOrder(scheduledAtInput, orderPayload, userId) {
  const jobId = await generateScheduledId();
  const now = new Date();

  const epochMs = parseScheduledToEpochMs(scheduledAtInput);
  if (!Number.isFinite(epochMs)) {
    throw new Error("Invalid scheduled_at (cannot parse to time).");
  }

  const scheduled_at = new Date(epochMs).toISOString(); // UTC ISO
  const scheduled_at_local = epochToBhutanIso(epochMs); // Bhutan wall clock +06:00

  const tmpData = { order_payload: orderPayload };
  const businessId = extractBusinessIdFromJob(tmpData);

  const payload = {
    job_id: jobId,
    user_id: userId,
    business_id: businessId ?? null,

    // keep both for clarity
    scheduled_at, // UTC ISO (machine)
    scheduled_at_local, // Bhutan ISO +06:00 (display)
    scheduled_epoch_ms: epochMs, // optional debug

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
    .zadd(ZSET_KEY, epochMs, jobId) // ✅ score is epochMs (correct trigger)
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
