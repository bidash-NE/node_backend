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
  process.env.ORDER_CREATE_URL || "http://localhost:1001/orders";

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
 * Normalize payload for order creation
 */
async function normalizeCreateOrderPayload(raw = {}) {
  const p = { ...(raw || {}) };

  // Handle nested payload string
  if (typeof p.payload === "string" && p.payload.trim()) {
    try {
      const parsedPayload = JSON.parse(p.payload);

      // Merge parsed payload, giving priority to existing fields
      Object.keys(parsedPayload).forEach((key) => {
        if (p[key] === undefined || p[key] === null) {
          p[key] = parsedPayload[key];
        }
      });

      // Extract images from nested payload
      if (
        parsedPayload.special_photos &&
        Array.isArray(parsedPayload.special_photos)
      ) {
        p.special_photos = parsedPayload.special_photos;
      }

      if (parsedPayload.delivery_photo_url) {
        p.delivery_photo_url = parsedPayload.delivery_photo_url;
      }

      // Process items from nested payload
      if (parsedPayload.items && Array.isArray(parsedPayload.items)) {
        p.items = parsedPayload.items.map((item) => ({
          ...item,
          business_name: item.business_name || item.businessName || null,
          business_id: item.business_id || item.businessId || null,
          item_image: item.item_image || item.image || null,
          image: undefined,
        }));
      }

      delete p.payload;
    } catch (err) {
      console.error("[SCHED] Failed to parse nested payload:", err.message);
    }
  }

  // Process items and ensure business_name is present
  if (Array.isArray(p.items) && p.items.length > 0) {
    // Get global business_id if not in items
    const globalBusinessId = p.business_id || null;
    const globalBusinessName = p.business_name || null;

    // First pass: ensure basic fields
    p.items = p.items.map((item) => ({
      ...item,
      business_id: item.business_id || globalBusinessId,
      business_name: item.business_name || globalBusinessName || null,
      menu_id: item.menu_id,
      item_name: item.name || item.item_name,
      item_image: item.item_image || item.image || null,
      quantity: Number(item.quantity) || 1,
      price: Number(item.price || item.unit_price) || 0,
      subtotal: Number(item.subtotal || item.line_subtotal || 0),
      tax_rate: Number(item.tax_rate || 0),
      tax_amount: Number(item.tax_amount || 0),
    }));

    // Fetch missing business names from database
    const missingBusinessIds = [
      ...new Set(
        p.items
          .filter((item) => !item.business_name && item.business_id)
          .map((item) => item.business_id),
      ),
    ];

    if (missingBusinessIds.length) {
      try {
        const placeholders = missingBusinessIds.map(() => "?").join(",");
        const [businesses] = await db.query(
          `SELECT business_id, business_name FROM merchant_business_details WHERE business_id IN (${placeholders})`,
          missingBusinessIds,
        );

        const businessNameMap = new Map();
        businesses.forEach((b) =>
          businessNameMap.set(b.business_id, b.business_name),
        );

        p.items = p.items.map((item) => ({
          ...item,
          business_name:
            item.business_name ||
            businessNameMap.get(item.business_id) ||
            "Unknown Business",
        }));
      } catch (err) {
        console.error("[SCHED] Failed to fetch business names:", err.message);
      }
    }
  }

  // Remove scheduler-only keys
  delete p.scheduled_at;
  delete p.scheduled_at_local;
  delete p.scheduled_epoch_ms;
  delete p.created_at;
  delete p.updated_at;
  delete p.job_id;
  delete p.business_details;
  delete p.retry_at;
  delete p.retry_count;
  delete p.last_error;

  // Normalize service_type
  if (p.service_type != null) {
    p.service_type = String(p.service_type).trim().toUpperCase();
  }

  // Normalize payment method
  if (p.payment_method != null) {
    p.payment_method = String(p.payment_method).trim().toUpperCase();
  }

  // Normalize fulfillment_type
  if (p.fulfillment_type != null) {
    const f = String(p.fulfillment_type).trim();
    p.fulfillment_type = f.toLowerCase() === "pickup" ? "Pickup" : "Delivery";
  } else {
    p.fulfillment_type = "Delivery";
  }

  // Map deliver_to -> delivery_address
  if (!p.delivery_address && p.deliver_to) {
    p.delivery_address = p.deliver_to;
  }

  // Handle delivery_address if it's a string
  if (p.delivery_address && typeof p.delivery_address === "string") {
    try {
      p.delivery_address = JSON.parse(p.delivery_address);
    } catch (e) {}
  }

  // Items validation
  const items = Array.isArray(p.items) ? p.items : [];
  p.items = items;

  // Delivery fee calculation
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
    const itemsSubtotal = sum(
      items.map((it) => it?.subtotal || it?.line_subtotal || 0),
    );
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

  // Priority should be boolean
  if (p.priority != null) p.priority = !!p.priority;

  // Set status to CONFIRMED for scheduled orders
  p.status = "CONFIRMED";

  // PHOTO MAPPING
  const photos = Array.isArray(p.special_photos)
    ? p.special_photos
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
    : [];

  if (!p.delivery_photo_url) {
    p.delivery_photo_url = photos[0] || null;
  }

  p.special_photos = photos;

  // Log final payload for debugging
  console.log(
    "[SCHED] Final normalized payload:",
    JSON.stringify(
      {
        user_id: p.user_id,
        business_id: p.business_id,
        service_type: p.service_type,
        items_count: p.items.length,
        items_with_business_name: p.items.every((i) => i.business_name),
        total_amount: p.total_amount,
      },
      null,
      2,
    ),
  );

  return p;
}

/* ===================== Helper: call existing Order API ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = await normalizeCreateOrderPayload(orderPayload);

  // ✅ VALIDATE: Ensure all items have business_name before sending
  if (Array.isArray(payloadToSend.items) && payloadToSend.items.length) {
    const missingBusinessName = payloadToSend.items.some(
      (item) => !item.business_name,
    );
    if (missingBusinessName) {
      console.error(
        "[SCHED] Missing business_name in items:",
        JSON.stringify(
          payloadToSend.items.map((i) => ({
            menu_id: i.menu_id,
            business_id: i.business_id,
            business_name: i.business_name,
          })),
          null,
          2,
        ),
      );

      // Final attempt to fetch missing business names
      const businessIds = [
        ...new Set(
          payloadToSend.items
            .map((item) => item.business_id)
            .filter((id) => id),
        ),
      ];
      if (businessIds.length) {
        const [businesses] = await db.query(
          `SELECT business_id, business_name FROM merchant_business_details WHERE business_id IN (?)`,
          [businessIds],
        );
        const businessMap = new Map(
          businesses.map((b) => [b.business_id, b.business_name]),
        );

        payloadToSend.items = payloadToSend.items.map((item) => ({
          ...item,
          business_name:
            item.business_name ||
            businessMap.get(item.business_id) ||
            "Unknown Business",
        }));
      }
    }
  }

  try {
    console.log(
      "[SCHED] Sending to orders API:",
      JSON.stringify(
        {
          url: ORDER_CREATE_URL,
          user_id: payloadToSend.user_id,
          business_id: payloadToSend.business_id,
          items_count: payloadToSend.items?.length,
          has_business_names: payloadToSend.items?.every(
            (i) => i.business_name,
          ),
        },
        null,
        2,
      ),
    );

    const response = await axios.post(ORDER_CREATE_URL, payloadToSend, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    const data = response.data || {};

    if (data.success === false || data.ok === false) {
      throw new Error(
        data.message || data.error || "Order API returned success=false",
      );
    }

    const orderId =
      data.order_id || data.id || (data.data && data.data.order_id);
    return orderId || null;
  } catch (err) {
    console.error("[SCHED] API Error Details:");
    console.error("- Message:", err.message);
    console.error("- Status:", err.response?.status);
    console.error(
      "- Response data:",
      JSON.stringify(err.response?.data, null, 2),
    );
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
    await redis.set(
      buildErrorKey(jobId),
      String(err.message).slice(0, 1000),
      "EX",
      ATTEMPT_TTL_SECONDS,
    );
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.log(`[SCHED] Permanent failure for ${jobId} due to 400 error`);
    return;
  }

  // 404 errors - not found
  if (status === 404) {
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.log(`[SCHED] Permanent failure for ${jobId} due to 404 error`);
    return;
  }

  // Check max attempts
  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(jobId, err.message, body);
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
    console.log(
      `[SCHED] Permanent failure for ${jobId} after ${MAX_ATTEMPTS} attempts`,
    );
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
    console.log(
      `[SCHED] Retry ${attempts}/${MAX_ATTEMPTS} for ${jobId} scheduled at ${new Date(retryAt).toISOString()}`,
    );
  }

  await redis.del(buildLockKey(jobId));
}

/* ===================== Core processing ===================== */

async function processJob(jobId) {
  const jobKey = buildJobKey(jobId);

  try {
    const raw = await redis.get(jobKey);
    if (!raw) {
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      console.log(`[SCHED] Job ${jobId} not found, removing from queue`);
      return;
    }

    const data = JSON.parse(raw);
    const { order_payload } = data;

    if (!order_payload) {
      throw new Error("Missing order_payload in scheduled job");
    }

    // Check if this is a retry
    if (data.retry_at && new Date(data.retry_at).getTime() > Date.now()) {
      console.log(
        `[SCHED] Job ${jobId} scheduled for retry at ${data.retry_at}, skipping`,
      );
      await redis.del(buildLockKey(jobId));
      return;
    }

    const status = order_payload?.status || "PENDING";

    // REJECTED - skip and cleanup
    if (status === "REJECTED") {
      console.log(`[SCHED] Job ${jobId} is REJECTED, removing from queue`);
      await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();
      return;
    }

    // PENDING - wait for acceptance, but expire after 30 minutes
    if (status === "PENDING") {
      const createdAtMs = data.created_at
        ? new Date(data.created_at).getTime()
        : NaN;

      const nowMs = Date.now();

      const pendingAgeMs = Number.isFinite(createdAtMs)
        ? nowMs - createdAtMs
        : nowMs - (Number(data.scheduled_epoch_ms) || nowMs);

      const PENDING_ACCEPT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

      if (pendingAgeMs >= PENDING_ACCEPT_TIMEOUT_MS) {
        console.log(
          `[SCHED] Job ${jobId} was PENDING for more than 30 minutes. Expiring scheduled order.`,
        );

        // Notify user before deleting the scheduled order
        try {
          const {
            sendUserNotification,
          } = require("../services/expoNotificationService");

          await sendUserNotification({
            user_id: data.user_id,
            title: "Scheduled Order Expired",
            body: "Your scheduled order was not accepted by the business within 30 minutes and has been cancelled.",
          });
        } catch (notifyErr) {
          console.error(
            "[SCHED] Failed to notify user about expired scheduled order:",
            notifyErr.message,
          );
        }

        // Optional: insert notification into notifications table also
        try {
          const notificationData = JSON.stringify({
            job_id: jobId,
            status: "EXPIRED",
            reason: "Not accepted within 30 minutes",
            scheduled_at: data.scheduled_at_local || data.scheduled_at || null,
          });

          await db.query(
            `
          INSERT INTO notifications
            (user_id, type, title, message, data, status, created_at)
          VALUES
            (?, ?, ?, ?, ?, 'unread', NOW())
        `,
            [
              data.user_id,
              "order_status",
              "Scheduled Order Expired",
              "Your scheduled order was not accepted by the business within 30 minutes and has been cancelled.",
              notificationData,
            ],
          );
        } catch (dbNotifyErr) {
          console.error(
            "[SCHED] Failed to insert expiry notification:",
            dbNotifyErr.message,
          );
        }

        // Delete from Redis queue and scheduled job storage
        await redis
          .multi()
          .zrem(ZSET_KEY, jobId)
          .del(jobKey)
          .del(buildLockKey(jobId))
          .del(buildAttemptsKey(jobId))
          .del(buildErrorKey(jobId))
          .exec();

        return;
      }

      console.log(
        `[SCHED] Job ${jobId} is PENDING, waiting for acceptance. Will recheck later.`,
      );

      // Move pending job forward so old pending jobs do not block accepted jobs
      const nextCheckAt = Date.now() + 60 * 1000; // recheck after 1 minute

      await redis
        .multi()
        .zadd(ZSET_KEY, nextCheckAt, jobId)
        .del(buildLockKey(jobId))
        .exec();

      return;
    }
    // Unknown status
    if (status !== "ACCEPTED") {
      console.log(`[SCHED] Job ${jobId} has unknown status: ${status}`);
      await redis.del(buildLockKey(jobId));
      return;
    }

    // ACCEPTED - process and migrate to orders table
    console.log(`[SCHED] 🚀 Processing accepted scheduled order ${jobId}`);

    // Create a complete order payload with all necessary fields
    const completePayload = {
      ...order_payload,
      user_id: data.user_id,
      business_id: data.business_id,
      scheduled_at: data.scheduled_at,
      scheduled_at_local: data.scheduled_at_local,
    };

    // Log the payload being sent
    console.log(
      `[SCHED] Order payload for ${jobId}:`,
      JSON.stringify(
        {
          user_id: completePayload.user_id,
          business_id: completePayload.business_id,
          service_type: completePayload.service_type,
          items_count: completePayload.items?.length,
          items_have_business_names: completePayload.items?.every(
            (i) => i.business_name,
          ),
        },
        null,
        2,
      ),
    );

    const orderId = await createOrderFromScheduledPayload(completePayload);

    // Send notification
    if (data.user_id && (data.scheduled_at || data.scheduled_at_local)) {
      await insertNotificationForScheduledOrder(
        data.user_id,
        orderId,
        data.scheduled_at_local || data.scheduled_at,
      );
    }

    // Send push notification
    try {
      const {
        sendUserNotification,
      } = require("../services/expoNotificationService");
      await sendUserNotification({
        user_id: data.user_id,
        title: "Order Confirmed",
        body: `Your scheduled order ${orderId || jobId} has been confirmed and is being processed.`,
      });
    } catch (pushErr) {
      console.error("[SCHED] Push notification failed:", pushErr.message);
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
      `[SCHED] ✅ Successfully processed ${jobId} → Order ID: ${orderId || "created"}`,
    );
  } catch (err) {
    console.error(`[SCHED] ❌ Failed to process ${jobId}:`, err.message);
    await failAndMaybeStopRetry(jobId, err);
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueJobIds(nowTs);

    if (!jobIds || !jobIds.length) return;

    console.log(`[SCHED] Found ${jobIds.length} due jobs`);

    for (const jobId of jobIds) {
      const claimed = await tryClaimJob(jobId);
      if (!claimed) continue;
      await processJob(jobId);
    }
  } catch (err) {
    console.error("[SCHED] Tick error:", err.message);
  }
}

async function processSingleJob(jobId) {
  const claimed = await tryClaimJob(jobId);
  if (claimed) {
    await processJob(jobId);
    return true;
  }
  return false;
}

function startScheduledOrderProcessor() {
  console.log("[SCHED] Starting scheduled order processor...");
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[SCHED] Processor running every ${POLL_INTERVAL_MS}ms`);
}

module.exports = {
  startScheduledOrderProcessor,
  processSingleJob,
};
