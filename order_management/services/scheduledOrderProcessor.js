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
const BASE_RETRY_DELAY_MS = 60000; // 1 minute base delay
const MAX_RETRY_DELAY_MS = 3600000; // 1 hour max delay

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
 * Recursively extract all images from any nested structure
 */
function extractImagesFromItem(item) {
  if (!item) return null;

  // Direct image fields
  if (item.item_image) return item.item_image;
  if (item.image) return item.image;
  if (item.image_url) return item.image_url;
  if (item.photo) return item.photo;
  if (item.url) return item.url;

  // Check if item has a nested item object
  if (item.item && typeof item.item === "object") {
    return extractImagesFromItem(item.item);
  }

  // Check if item has product data
  if (item.product && typeof item.product === "object") {
    return extractImagesFromItem(item.product);
  }

  // Check if item has menu data
  if (item.menu && typeof item.menu === "object") {
    return extractImagesFromItem(item.menu);
  }

  return null;
}

/**
 * Normalize payload for order creation
 */
function normalizeCreateOrderPayload(raw = {}) {
  const p = { ...(raw || {}) };

  // Handle nested payload string
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

  // ✅ Extract business_details to add to each item
  const businessDetails = p.business_details || {};
  const defaultBusinessId = businessDetails.business_id
    ? Number(businessDetails.business_id)
    : p.business_id || null;
  const defaultBusinessName = businessDetails.business_name || null;

  // ✅ Transform items to match orders API format
  if (Array.isArray(p.items) && p.items.length > 0) {
    p.items = p.items.map((item) => ({
      // Required fields for orders API
      business_id: item.business_id || defaultBusinessId,
      business_name: item.business_name || defaultBusinessName,
      menu_id: item.menu_id,
      item_name: item.name || item.item_name,
      item_image: item.image || item.item_image,
      quantity: item.quantity,
      price: item.unit_price || item.price,
      subtotal: item.line_subtotal || item.subtotal,

      // Optional fields
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
    }));
  }

  // ✅ Remove scheduler-only fields
  delete p.scheduled_at;
  delete p.scheduled_at_local;
  delete p.scheduled_epoch_ms;
  delete p.created_at;
  delete p.updated_at;
  delete p.job_id;
  delete p.business_details;
  delete p.payload;

  // ✅ Ensure status is CONFIRMED
  p.status = "CONFIRMED";

  // ✅ Normalize other fields
  if (p.service_type) {
    p.service_type = String(p.service_type).trim().toUpperCase();
  }

  if (p.payment_method) {
    p.payment_method = String(payment_method).trim().toUpperCase();
  }

  // ✅ Handle delivery_address (ensure it's an object, not string)
  if (p.delivery_address && typeof p.delivery_address === "string") {
    try {
      p.delivery_address = JSON.parse(p.delivery_address);
    } catch (e) {
      // Keep as is
    }
  }

  // ✅ Log transformed items for debugging
  console.log(
    "[SCHED] Transformed items for orders API:",
    JSON.stringify(p.items, null, 2),
  );

  return p;
}

/* ===================== Helper: call existing Order API ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = normalizeCreateOrderPayload(orderPayload);

  // ✅ Additional validation before sending
  if (!payloadToSend.items || payloadToSend.items.length === 0) {
    console.error("[SCHED] ERROR: No items in payload after normalization!");
    throw new Error("No items in order payload");
  }

  // Check if items have images
  const itemsWithImages = payloadToSend.items.filter(
    (i) => i.item_image || i.image,
  );
  console.log(
    `[SCHED] Items with images: ${itemsWithImages.length}/${payloadToSend.items.length}`,
  );

  try {
    console.log("[SCHED] 📦 Creating order for user:", payloadToSend.user_id);
    console.log("[SCHED] Service type:", payloadToSend.service_type);
    console.log("[SCHED] Total amount:", payloadToSend.total_amount);

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
    console.log(`[SCHED] ✅ Order created successfully with ID: ${orderId}`);
    return orderId || null;
  } catch (err) {
    console.error("[SCHED] ❌ API Error:", err.message);
    if (err.response) {
      console.error("[SCHED] Status:", err.response.status);
      console.error(
        "[SCHED] Response:",
        JSON.stringify(err.response.data, null, 2),
      );
    }
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
    const title = "Order Confirmed";
    const message = `Your scheduled order has been confirmed for ${scheduledLocal}`;

    const dataJson = JSON.stringify({
      order_id: orderId || null,
      status: "CONFIRMED",
      scheduled_at: scheduledAt,
    });

    const sql = `
      INSERT INTO notifications
        (user_id, type, title, message, data, status, created_at)
      VALUES
        (?, ?, ?, ?, ?, 'unread', NOW())
    `;

    await db.query(sql, [userId, type, title, message, dataJson]);
    console.log(`[SCHED] Notification sent to user ${userId}`);
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
  let attempts = await redis.get(attemptsKey);
  attempts = attempts ? parseInt(attempts) + 1 : 1;
  await redis.set(attemptsKey, attempts, "EX", ATTEMPT_TTL_SECONDS);

  const status = err?.response?.status;
  const body = err?.response?.data || null;

  // 400 errors (validation) - permanent failure
  if (status === 400) {
    console.error(`[SCHED] ❌ ${jobId} permanent failure (400 error)`);
    await redis.set(
      buildErrorKey(jobId),
      String(err.message).slice(0, 1000),
      "EX",
      ATTEMPT_TTL_SECONDS,
    );
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    return;
  }

  // 404 errors - not found
  if (status === 404) {
    console.error(`[SCHED] ❌ ${jobId} permanent failure (404 not found)`);
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    return;
  }

  // Check max attempts
  if (attempts >= MAX_ATTEMPTS) {
    console.error(`[SCHED] ❌ ${jobId} failed after ${MAX_ATTEMPTS} attempts`);
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    return;
  }

  // Calculate retry delay with exponential backoff
  const delayMs = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );
  const retryAt = Date.now() + delayMs;

  // Update order score for retry
  const jobKey = buildJobKey(jobId);
  const raw = await redis.get(jobKey);
  if (raw) {
    const data = JSON.parse(raw);
    data.retry_at = new Date(retryAt).toISOString();
    data.retry_count = attempts;
    data.last_error = err.message;
    await redis.set(jobKey, JSON.stringify(data));
    await redis.zadd(ZSET_KEY, retryAt, jobId);
  }

  await redis.del(buildLockKey(jobId));
  console.warn(
    `[SCHED] ⚠️ ${jobId} retry ${attempts}/${MAX_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
  );
}

/* ===================== Core processing ===================== */

async function processJob(jobId) {
  const jobKey = buildJobKey(jobId);

  try {
    console.log(`[SCHED] 🚀 Processing job: ${jobId}`);

    const raw = await redis.get(jobKey);
    if (!raw) {
      console.log(
        `[SCHED] Job ${jobId} not found in Redis, removing from ZSET`,
      );
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      return;
    }

    const data = JSON.parse(raw);
    const { order_payload } = data;

    if (!order_payload) {
      throw new Error("Missing order_payload in scheduled job");
    }

    // Debug: Log the structure of order_payload
    // console.log(
    //   "[SCHED] order_payload structure:",
    //   JSON.stringify(
    //     {
    //       has_payload_field: !!order_payload.payload,
    //       payload_type: typeof order_payload.payload,
    //       has_items: !!order_payload.items,
    //       items_count: order_payload.items?.length,
    //       has_order_payload: !!order_payload.order_payload,
    //       status: order_payload.status,
    //     },
    //     null,
    //     2,
    //   ),
    // );

    // Check if this is a retry
    if (data.retry_at && new Date(data.retry_at).getTime() > Date.now()) {
      console.log(`[SCHED] Job ${jobId} is scheduled for retry later`);
      await redis.del(buildLockKey(jobId));
      return;
    }

    const status = order_payload?.status || "PENDING";

    // REJECTED - skip
    if (status === "REJECTED") {
      console.log(`[SCHED] ❌ ${jobId} rejected, removing`);
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      return;
    }

    // PENDING - wait
    if (status === "PENDING") {
      console.log(`[SCHED] ⏳ ${jobId} still pending, waiting...`);
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
    if (data.retry_count) {
      console.log(
        `[SCHED] 🔄 Retry ${data.retry_count}/${MAX_ATTEMPTS} for ${jobId}`,
      );
    } else {
      console.log(`[SCHED] ✅ Processing ${jobId} (ACCEPTED)`);
    }

    // ✅ Ensure items have item_image before processing
    console.log("[SCHED] Checking order_payload for items...");

    // Try to extract items from various possible locations
    let itemsToProcess = null;

    if (Array.isArray(order_payload.items) && order_payload.items.length > 0) {
      itemsToProcess = order_payload.items;
      console.log(
        `[SCHED] Found ${itemsToProcess.length} items in order_payload.items`,
      );
    } else if (
      order_payload.payload &&
      typeof order_payload.payload === "string"
    ) {
      console.log("[SCHED] Looking for items in order_payload.payload string");
      try {
        const parsedPayload = JSON.parse(order_payload.payload);
        if (Array.isArray(parsedPayload.items)) {
          itemsToProcess = parsedPayload.items;
          console.log(
            `[SCHED] Found ${itemsToProcess.length} items in parsed payload`,
          );
        }
      } catch (e) {
        console.error("[SCHED] Failed to parse payload for items:", e.message);
      }
    }

    if (itemsToProcess && itemsToProcess.length > 0) {
      order_payload.items = itemsToProcess.map((item) => {
        const imageUrl = extractImagesFromItem(item);
        console.log(
          `[SCHED] Item menu_id: ${item.menu_id}, image found: ${!!imageUrl}`,
        );
        return {
          ...item,
          item_image: imageUrl,
          image: item.image || imageUrl,
        };
      });

      console.log(
        `[SCHED] Items prepared: ${order_payload.items.length}, with images: ${order_payload.items.filter((i) => i.item_image).length}`,
      );
    }

    // Set status to CONFIRMED (merchant already accepted)
    order_payload.status = "CONFIRMED";

    const orderId = await createOrderFromScheduledPayload(order_payload);

    // Send notification
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

    console.log(
      `[SCHED] ✅✅ ${jobId} → Order ${orderId || "created"} (CONFIRMED)`,
    );
  } catch (err) {
    console.error(`[SCHED] ❌ ${jobId} error:`, err.message);
    console.error(`[SCHED] Error stack:`, err.stack);
    await failAndMaybeStopRetry(jobId, err);
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueJobIds(nowTs);

    if (!jobIds || !jobIds.length) return;

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
