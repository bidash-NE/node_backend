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

/**
 * URL of your existing "create order" API (for normal orders).
 * Set in .env, for example:
 *   ORDER_CREATE_URL=http://localhost:5000/api/orders
 */
const ORDER_CREATE_URL =
  process.env.ORDER_CREATE_URL || "https://grab.newedge.bt/orders/orders";

const POLL_INTERVAL_MS = 5000; // check every 5 seconds
const BATCH_SIZE = 20;

/* ===================== Helper: call existing Order API ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  try {
    const payloadToSend = {
      ...orderPayload,
      status: "PENDING",
    };

    const response = await axios.post(ORDER_CREATE_URL, payloadToSend, {
      timeout: 15000,
    });

    const data = response.data || {};

    if (data.success === false) {
      throw new Error(data.message || "Order API returned success=false");
    }

    const orderId =
      data.order_id || data.id || (data.data && data.data.order_id);

    if (!orderId) {
      console.warn(
        "Order created from scheduled job, but could not find order_id in response"
      );
    }

    return orderId || null;
  } catch (err) {
    console.error(
      "Error calling ORDER_CREATE_URL:",
      ORDER_CREATE_URL,
      err.message
    );
    throw err;
  }
}

/* ===================== Helper: notification insert ===================== */

/**
 * Insert a notification row after a scheduled job has been processed
 * and an order has been placed.
 *
 * Message format:
 *   "Your order has been scheduled successfully for 17/11/2025, 16:05:00"
 */
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

    const type = "order_status"; // matches your existing style
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
    console.error(
      "Failed to insert notification for scheduled order:",
      err.message
    );
  }
}

/* ===================== Core scheduler helpers ===================== */

async function fetchDueJobIds(nowTs) {
  return redis.zrangebyscore(ZSET_KEY, 0, nowTs, "LIMIT", 0, BATCH_SIZE);
}

async function tryClaimJob(jobId) {
  const lockKey = buildLockKey(jobId);
  const result = await redis.set(lockKey, "1", "NX", "EX", 60);
  return result === "OK";
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

    if (!order_payload) {
      throw new Error("Missing order_payload in scheduled job");
    }

    order_payload.status = "PENDING";

    const orderId = await createOrderFromScheduledPayload(order_payload);

    // ✅ Insert notification after successful order creation
    if (data.user_id && data.scheduled_at) {
      await insertNotificationForScheduledOrder(
        data.user_id,
        orderId,
        data.scheduled_at
      );
    }

    // Cleanup
    await redis
      .multi()
      .zrem(ZSET_KEY, jobId)
      .del(jobKey)
      .del(buildLockKey(jobId))
      .exec();

    console.log(
      `Scheduled job ${jobId} processed successfully. Order ID: ${
        orderId || "N/A"
      }`
    );
  } catch (err) {
    console.error(`Error processing scheduled job ${jobId}:`, err.message);

    await redis.set(
      `scheduled_order_error:${jobId}`,
      String(err.message).slice(0, 1000)
    );
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueJobIds(nowTs);
    if (!jobIds || !jobIds.length) return;

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
