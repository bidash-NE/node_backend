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

const ORDER_CREATE_URL = process.env.ORDER_CREATE_URL; // set to http://localhost:1001/orders in local

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
 * Extract photos from any known key and normalize.
 * Returns: { arr: string[], str: string|null }
 *
 * - arr: array of photo paths/urls (cleaned)
 * - str: value to store in orders.delivery_photo_url (string)
 *
 * NOTE:
 * - If your DB column is VARCHAR(500), storing JSON of many paths may truncate.
 * - But you said it’s saving NULL now — so at least this makes it non-null.
 */
function normalizePhotos(rawPayload) {
  const p = rawPayload || {};

  // Candidate sources (array or string)
  const candidates = [
    p.special_photos,
    p.delivery_photos,
    p.delivery_photo_urls,
    p.delivery_photo_url, // could be string or array in some cases
    p.photo_urls,
  ];

  let arr = [];

  for (const c of candidates) {
    if (!c) continue;

    if (Array.isArray(c)) {
      arr = c;
      break;
    }

    if (typeof c === "string" && c.trim()) {
      // allow single string, or JSON array string
      const parsed = safeJsonParse(c);
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else {
        arr = [c.trim()];
      }
      break;
    }
  }

  // Clean values
  arr = (arr || [])
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean);

  // Choose what to store into orders.delivery_photo_url
  // Best: JSON string of array so you don’t lose photos
  const str = arr.length ? JSON.stringify(arr) : null;

  return { arr, str };
}

/**
 * Make sure payload matches createOrder(req,res) validations
 */
function normalizeCreateOrderPayload(raw = {}) {
  const p = { ...(raw || {}) };

  // remove scheduler-only keys if present
  delete p.scheduled_at;
  delete p.scheduled_at_local;
  delete p.scheduled_epoch_ms;

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

  // ✅ delivery_fee required
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
      ).toFixed(2)
    );
  } else {
    p.total_amount = Number(p.total_amount);
  }

  // priority should be boolean
  if (p.priority != null) p.priority = !!p.priority;

  // status should be PENDING for creation
  p.status = "PENDING";

  // ✅ PHOTO MAPPING (this is the main fix)
  // scheduled jobs contain special_photos[] but orders table uses delivery_photo_url
  const photos = Array.isArray(p.special_photos)
    ? p.special_photos
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
    : [];

  // If your order API expects delivery_photo_url (single string):
  if (!p.delivery_photo_url) {
    p.delivery_photo_url = photos[0] || null;
  }

  // If your order API expects special_photos too, keep it (no harm):
  p.special_photos = photos;

  return p;
}

/* ===================== Helper: call existing Order API ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = normalizeCreateOrderPayload(orderPayload);

  try {
    const photoLen =
      payloadToSend?.delivery_photo_url != null
        ? String(payloadToSend.delivery_photo_url).length
        : 0;

    console.log(
      "[SCHED] photo mapping:",
      JSON.stringify(
        {
          has_special_photos: Array.isArray(payloadToSend.special_photos),
          special_photos_count: Array.isArray(payloadToSend.special_photos)
            ? payloadToSend.special_photos.length
            : 0,
          has_delivery_photo_url: payloadToSend.delivery_photo_url != null,
          delivery_photo_url_len: photoLen,
          delivery_photo_url_preview:
            payloadToSend.delivery_photo_url && photoLen > 120
              ? String(payloadToSend.delivery_photo_url).slice(0, 120) + "..."
              : payloadToSend.delivery_photo_url || null,
        },
        null,
        2
      )
    );

    console.log(
      "[SCHED] sending payload:",
      JSON.stringify(payloadToSend, null, 2)
    );

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
    if (!orderId) {
      console.warn(
        "[SCHED] Order created but order_id not found in response:",
        data
      );
    }

    return orderId || null;
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;

    console.error("[SCHED] Error calling ORDER_CREATE_URL:", ORDER_CREATE_URL);
    console.error("[SCHED] err.message:", err.message);
    console.error("[SCHED] HTTP:", status);
    console.error("[SCHED] Response body:", JSON.stringify(body, null, 2));

    // show what we sent
    console.error(
      "[SCHED] Sent payload keys:",
      Object.keys(payloadToSend || {})
    );

    throw err;
  }
}

/* ===================== Helper: notification insert ===================== */

async function insertNotificationForScheduledOrder(
  userId,
  orderId,
  scheduledAt
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
    LOCK_TTL_SECONDS
  );
  if (result === "OK") return true;

  const ttl = await getLockTTL(lockKey);

  // If lock exists but has NO expiry, it can deadlock forever — fix it.
  if (ttl === -1) {
    console.warn(`[SCHED] lock has no TTL, deleting stale lock: ${lockKey}`);
    await redis.del(lockKey);

    const retry = await redis.set(
      lockKey,
      lockValue,
      "NX",
      "EX",
      LOCK_TTL_SECONDS
    );
    if (retry === "OK") return true;
  }

  console.log(`[SCHED] skip ${jobId} (locked). exists=1 ttl=${ttl}`);
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
    ATTEMPT_TTL_SECONDS
  );
}

async function failAndMaybeStopRetry(jobId, err) {
  const attemptsKey = buildAttemptsKey(jobId);
  const attempts = await redis.incr(attemptsKey);
  await redis.expire(attemptsKey, ATTEMPT_TTL_SECONDS);

  const status = err?.response?.status;
  const body = err?.response?.data || null;

  // 400 => validation/wallet issues: retrying will usually never help.
  if (status === 400) {
    await redis.set(
      buildErrorKey(jobId),
      String(err.message).slice(0, 1000),
      "EX",
      ATTEMPT_TTL_SECONDS
    );
    await markFailed(jobId, err.message, body);

    // remove from queue so it stops spamming
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.error(
      `[SCHED] job ${jobId} marked FAILED due to HTTP 400 (payload/validation).`
    );
    return;
  }

  // other errors: allow a few retries
  await redis.set(
    buildErrorKey(jobId),
    String(err.message).slice(0, 1000),
    "EX",
    ATTEMPT_TTL_SECONDS
  );

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.error(`[SCHED] job ${jobId} stopped after ${attempts} attempts.`);
    return;
  }

  // let it retry later (do NOT remove from ZSET)
  await redis.del(buildLockKey(jobId));
  console.warn(
    `[SCHED] job ${jobId} will retry later. attempts=${attempts}/${MAX_ATTEMPTS}`
  );
}

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

    if (!order_payload)
      throw new Error("Missing order_payload in scheduled job");

    // force PENDING
    order_payload.status = "PENDING";

    const orderId = await createOrderFromScheduledPayload(order_payload);

    // notification after success
    if (data.user_id && (data.scheduled_at || data.scheduled_at_local)) {
      await insertNotificationForScheduledOrder(
        data.user_id,
        orderId,
        data.scheduled_at_local || data.scheduled_at
      );
    }

    // cleanup
    await redis
      .multi()
      .zrem(ZSET_KEY, jobId)
      .del(jobKey)
      .del(buildLockKey(jobId))
      .del(buildAttemptsKey(jobId))
      .del(buildErrorKey(jobId))
      .exec();

    console.log(
      `[SCHED] ✅ job ${jobId} processed. Order ID: ${orderId || "N/A"}`
    );
  } catch (err) {
    console.error(`[SCHED] Error processing ${jobId}:`, err.message);
    await failAndMaybeStopRetry(jobId, err);
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueJobIds(nowTs);

    if (!jobIds || !jobIds.length) return;

    console.log(`[SCHED] due jobs: ${jobIds.length}`);

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
  console.log("Scheduled order processor started (inline).");
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startScheduledOrderProcessor };
