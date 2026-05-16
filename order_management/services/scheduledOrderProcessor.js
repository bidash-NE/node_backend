// services/scheduledOrderProcessor.js
const axios = require("axios");
const redis = require("../config/redis");
const db = require("../config/db");
const {
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
} = require("../models/scheduledOrderModel");

const BHUTAN_TZ = "Asia/Thimphu";

const ORDER_CREATE_URL =
  process.env.ORDER_CREATE_URL || "http://localhost:3001/orders";

const POLL_INTERVAL_MS = 5000;
const BATCH_SIZE = 20;

const LOCK_TTL_SECONDS = 60;

// retries
const MAX_ATTEMPTS = 5;
const ATTEMPT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

const buildAttemptsKey = (jobId) => `scheduled_order_attempts:${jobId}`;
const buildErrorKey = (jobId) => `scheduled_order_error:${jobId}`;
const buildFailedKey = (jobId) => `scheduled_order_failed:${jobId}`;

function sum(nums) {
  return nums.reduce((s, n) => s + (Number(n) || 0), 0);
}

/* ===================== helpers ===================== */

function safeJsonParse(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * ✅ FIXED: Properly handle nested payload string
 */
function normalizeCreateOrderPayload(raw = {}) {
  const p = { ...(raw || {}) };

  // ✅ CRITICAL FIX: Handle nested payload string
  if (typeof p.payload === "string" && p.payload.trim()) {
    try {
      const parsedPayload = JSON.parse(p.payload);
      Object.keys(parsedPayload).forEach((key) => {
        if (p[key] === undefined || p[key] === null) {
          p[key] = parsedPayload[key];
        }
      });
      delete p.payload;
    } catch (err) {
      console.error("[SCHED] Failed to parse nested payload:", err.message);
    }
  }

  // remove scheduler-only keys if present
  delete p.scheduled_at;
  delete p.scheduled_at_local;
  delete p.scheduled_epoch_ms;
  delete p.created_at;
  delete p.updated_at;
  delete p.job_id;

  // normalize service_type
  if (p.service_type != null) {
    p.service_type = String(p.service_type).trim().toUpperCase();
  }

  // normalize payment method
  if (p.payment_method != null) {
    p.payment_method = String(p.payment_method).trim().toUpperCase();
  }

  // normalize fulfillment_type
  if (p.fulfillment_type != null) {
    const f = String(p.fulfillment_type).trim();
    p.fulfillment_type = f.toLowerCase() === "pickup" ? "Pickup" : "Delivery";
  } else {
    p.fulfillment_type = "Delivery";
  }

  // map deliver_to -> delivery_address
  if (!p.delivery_address && p.deliver_to) {
    p.delivery_address = p.deliver_to;
  }

  // items
  const items = Array.isArray(p.items) ? p.items : [];
  p.items = items;

  // delivery_fee
  if (p.delivery_fee == null) {
    const perItem = items.map((it) => it?.delivery_fee);
    p.delivery_fee = Number(sum(perItem).toFixed(2));
  } else {
    p.delivery_fee = Number(p.delivery_fee);
  }

  if (p.platform_fee == null) p.platform_fee = 0;
  if (p.discount_amount == null) p.discount_amount = 0;

  p.platform_fee = Number(p.platform_fee);
  p.discount_amount = Number(p.discount_amount);

  if (p.total_amount == null) {
    const itemsSubtotal = sum(items.map((it) => it?.subtotal));
    p.total_amount = Number(
      (
        itemsSubtotal +
        (Number(p.delivery_fee) || 0) +
        (Number(p.platform_fee) || 0) -
        (Number(p.discount_amount) || 0)
      ).toFixed(2),
    );
  } else {
    p.total_amount = Number(p.total_amount);
  }

  // priority should be boolean
  if (p.priority != null) p.priority = !!p.priority;

  // status should be PENDING for creation
  p.status = "PENDING";

  // ✅ PHOTO MAPPING
  const photos = Array.isArray(p.special_photos)
    ? p.special_photos
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
    : [];

  if (!p.delivery_photo_url) {
    p.delivery_photo_url = photos[0] || null;
  }

  p.special_photos = photos;

  return p;
}

/* ===================== Helper: call existing Order API ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = normalizeCreateOrderPayload(orderPayload);

  try {
    console.log("[SCHED] 📦 Creating order for user:", payloadToSend.user_id);

    const response = await axios.post(ORDER_CREATE_URL, payloadToSend, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    const data = response.data || {};

    if (data.success === false) {
      throw new Error(data.message || "Order API returned success=false");
    }

    const orderId =
      data.order_id || data.id || (data.data && data.data.order_id);
    return orderId || null;
  } catch (err) {
    console.error("[SCHED] ❌ API Error:", err.message);
    throw err;
  }
}

/* ===================== Helper: notification insert ===================== */

async function insertNotificationForScheduledOrder(
  userId,
  orderId,
  scheduledAt,
) {
  try {
    const dateObj = new Date(scheduledAt);
    let scheduledLocal;
    try {
      scheduledLocal = dateObj.toLocaleString("en-GB", {
        timeZone: BHUTAN_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      scheduledLocal = scheduledAt;
    }

    const type = "order_status";
    const title = "Order scheduled";
    const message = `Your order has been scheduled successfully for ${scheduledLocal}`;
    const dataJson = JSON.stringify({
      order_id: orderId || null,
      status: "PENDING",
      scheduled_at: scheduledAt,
    });

    const sql = `
      INSERT INTO notifications
        (user_id, type, title, message, data, status, created_at)
      VALUES
        (?, ?, ?, ?, ?, 'unread', NOW())
    `;

    await db.query(sql, [userId, type, title, message, dataJson]);
  } catch (err) {
    console.error("[SCHED] Failed to insert notification:", err.message);
  }
}

/* ===================== Core scheduler helpers ===================== */

async function fetchDueJobIds(nowTs) {
  return redis.zrangebyscore(ZSET_KEY, 0, nowTs, "LIMIT", 0, BATCH_SIZE);
}

async function getLockTTL(lockKey) {
  try {
    const ttl = await redis.ttl(lockKey);
    return typeof ttl === "number" ? ttl : -2;
  } catch {
    return -2;
  }
}

async function tryClaimJob(jobId) {
  const lockKey = buildLockKey(jobId);
  const lockValue = `${process.pid}:${Date.now()}`;

  const result = await redis.set(
    lockKey,
    lockValue,
    "NX",
    "EX",
    LOCK_TTL_SECONDS,
  );
  if (result === "OK") return true;

  const ttl = await getLockTTL(lockKey);
  if (ttl === -1) {
    console.warn(`[SCHED] 🔓 Deleting stale lock: ${jobId}`);
    await redis.del(lockKey);
    const retry = await redis.set(
      lockKey,
      lockValue,
      "NX",
      "EX",
      LOCK_TTL_SECONDS,
    );
    if (retry === "OK") return true;
  }

  // Silent skip - don't log every locked job
  return false;
}

async function markFailed(jobId, errMessage, errBody = null) {
  const failedKey = buildFailedKey(jobId);
  const payload = {
    job_id: jobId,
    failed_at: new Date().toISOString(),
    error: String(errMessage || "").slice(0, 1000),
    response: errBody || null,
  };
  await redis.set(
    failedKey,
    JSON.stringify(payload),
    "EX",
    ATTEMPT_TTL_SECONDS,
  );
}

async function failAndMaybeStopRetry(jobId, err) {
  const attemptsKey = buildAttemptsKey(jobId);
  const attempts = await redis.incr(attemptsKey);
  await redis.expire(attemptsKey, ATTEMPT_TTL_SECONDS);

  const status = err?.response?.status;
  const body = err?.response?.data || null;

  if (status === 400) {
    await redis.set(
      buildErrorKey(jobId),
      String(err.message).slice(0, 1000),
      "EX",
      ATTEMPT_TTL_SECONDS,
    );
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.error(`[SCHED] ❌ ${jobId} failed (400 error)`);
    return;
  }

  await redis.set(
    buildErrorKey(jobId),
    String(err.message).slice(0, 1000),
    "EX",
    ATTEMPT_TTL_SECONDS,
  );

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.error(`[SCHED] ❌ ${jobId} failed after ${attempts} attempts`);
    return;
  }

  await redis.del(buildLockKey(jobId));
  console.warn(`[SCHED] ⚠️ ${jobId} retry ${attempts}/${MAX_ATTEMPTS}`);
}

/* ===================== Core processing ===================== */

async function processJob(jobId) {
  const jobKey = buildJobKey(jobId);

  try {
    const raw = await redis.get(jobKey);
    if (!raw) {
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      return;
    }

    const data = JSON.parse(raw);
    const { order_payload } = data;

    if (!order_payload) {
      throw new Error("Missing order_payload in scheduled job");
    }

    const status = order_payload?.status || "PENDING";

    // REJECTED - skip
    if (status === "REJECTED") {
      console.log(`[SCHED] ❌ ${jobId} rejected, removing`);
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      return;
    }

    // PENDING - wait (silent, no log)
    if (status === "PENDING") {
      await redis.del(buildLockKey(jobId));
      return;
    }

    // Unknown status
    if (status !== "ACCEPTED") {
      console.log(`[SCHED] ⚠️ ${jobId} unknown status: ${status}`);
      await redis.del(buildLockKey(jobId));
      return;
    }

    // ACCEPTED - process!
    console.log(`[SCHED] ✅ Processing ${jobId} (ACCEPTED)`);

    // Reset status for order table
    order_payload.status = "PENDING";

    const orderId = await createOrderFromScheduledPayload(order_payload);

    // Send notification after success
    if (data.user_id && (data.scheduled_at || data.scheduled_at_local)) {
      await insertNotificationForScheduledOrder(
        data.user_id,
        orderId,
        data.scheduled_at_local || data.scheduled_at,
      );
    }

    // Cleanup Redis
    await redis
      .multi()
      .zrem(ZSET_KEY, jobId)
      .del(jobKey)
      .del(buildLockKey(jobId))
      .del(buildAttemptsKey(jobId))
      .del(buildErrorKey(jobId))
      .exec();

    console.log(`[SCHED] ✅✅ ${jobId} → Order ${orderId || "created"}`);
  } catch (err) {
    console.error(`[SCHED] ❌ ${jobId} error:`, err.message);
    await failAndMaybeStopRetry(jobId, err);
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueJobIds(nowTs);

    if (!jobIds || !jobIds.length) return;

    // Only log once when there are due jobs
    console.log(`[SCHED] 🕐 Processing ${jobIds.length} due job(s)`);

    for (const jobId of jobIds) {
      const claimed = await tryClaimJob(jobId);
      if (!claimed) continue;
      await processJob(jobId);
    }
  } catch (err) {
    console.error("scheduledOrderProcessor tick error:", err);
  }
}

function startScheduledOrderProcessor() {
  console.log("✅ Scheduled order processor started");
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startScheduledOrderProcessor };
