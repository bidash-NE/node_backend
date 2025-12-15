// services/scheduledOrderProcessor.js
const axios = require("axios");
const redis = require("../config/redis");
const db = require("../config/db");
const {
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
} = require("../models/scheduledOrderModel");

const BHUTAN_TZ = "Asia/Thimphu";

// ✅ IMPORTANT: set this correctly to your real create-order endpoint (POST /orders)
const ORDER_CREATE_URL =
  process.env.ORDER_CREATE_URL || "http://localhost:1001/orders";

const POLL_INTERVAL_MS = Number(process.env.SCHEDULED_POLL_INTERVAL_MS || 5000);
const BATCH_SIZE = Number(process.env.SCHEDULED_BATCH_SIZE || 20);
const MAX_ATTEMPTS = Number(process.env.SCHEDULED_MAX_ATTEMPTS || 5);

function sumItemDeliveryFees(items) {
  return (items || []).reduce((s, it) => s + Number(it?.delivery_fee || 0), 0);
}
function sumSubtotals(items) {
  return (items || []).reduce((s, it) => s + Number(it?.subtotal || 0), 0);
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

// Ensure payload matches createOrder requirements before HTTP call
function normalizeForCreateOrder(orderPayload) {
  const p = { ...(orderPayload || {}) };
  const items = Array.isArray(p.items) ? p.items : [];

  p.service_type = String(p.service_type || "")
    .trim()
    .toUpperCase();
  p.payment_method = String(p.payment_method || "")
    .trim()
    .toUpperCase();
  p.fulfillment_type = String(p.fulfillment_type || "Delivery");

  if (p.discount_amount == null) p.discount_amount = 0;
  if (p.platform_fee == null) p.platform_fee = 0;

  if (p.delivery_fee == null) {
    p.delivery_fee = sumItemDeliveryFees(items);
  }

  if (p.total_amount == null) {
    const sub = sumSubtotals(items);
    const delivery = Number(p.delivery_fee || 0);
    const discount = Number(p.discount_amount || 0);
    p.total_amount = Number((sub + delivery - discount).toFixed(2));
  }

  // status forced to PENDING
  p.status = "PENDING";

  // delivery_address requirement for Delivery
  if (p.fulfillment_type === "Delivery") {
    const addr = p.delivery_address;
    const addrStr = isObj(addr)
      ? String(addr.address || "").trim()
      : String(addr || "").trim();
    if (!addrStr) {
      throw new Error("delivery_address is required for Delivery");
    }
  }

  // item required fields check (same as createOrder)
  for (const [idx, it] of items.entries()) {
    for (const f of [
      "business_id",
      "menu_id",
      "item_name",
      "quantity",
      "price",
      "subtotal",
    ]) {
      if (it?.[f] == null || it?.[f] === "") {
        throw new Error(`Item[${idx}] missing ${f}`);
      }
    }
  }

  return p;
}

/* ===================== Helper: call create order API ===================== */
async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = normalizeForCreateOrder(orderPayload);

  const response = await axios.post(ORDER_CREATE_URL, payloadToSend, {
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true, // we handle status manually
  });

  if (response.status < 200 || response.status >= 300) {
    const body = response.data;
    const msg =
      (body && (body.message || body.error)) ||
      `Order API failed with status ${response.status}`;
    const e = new Error(msg);
    e.response = { status: response.status, data: body };
    throw e;
  }

  const data = response.data || {};
  const orderId = data.order_id || data.id || (data.data && data.data.order_id);
  return orderId || null;
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

async function failAndMaybeStopRetry(jobId, err) {
  const attemptsKey = buildAttemptsKey(jobId);
  const attempts = await redis.incr(attemptsKey);

  const status = err?.response?.status;
  const body = err?.response?.data;

  await redis.set(
    `scheduled_order_error:${jobId}`,
    String(err?.message || "Unknown error").slice(0, 1000)
  );

  if (status) {
    await redis.set(
      `scheduled_order_error_http:${jobId}`,
      JSON.stringify({ status, body }).slice(0, 2000)
    );
  }

  // After MAX_ATTEMPTS, stop retrying (remove from zset but keep jobKey for inspection)
  if (attempts >= MAX_ATTEMPTS) {
    await redis.multi().zrem(ZSET_KEY, jobId).del(buildLockKey(jobId)).exec();

    console.error(
      `[SCHED] ${jobId} failed ${attempts} times -> removed from queue. Last error:`,
      err?.message
    );
  } else {
    console.error(
      `[SCHED] ${jobId} failed attempt ${attempts}/${MAX_ATTEMPTS}:`,
      err?.message
    );
  }
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

    const orderId = await createOrderFromScheduledPayload(order_payload);

    // ✅ Insert notification after successful order creation
    if (data.user_id && data.scheduled_at) {
      await insertNotificationForScheduledOrder(
        data.user_id,
        orderId,
        data.scheduled_at
      );
    }

    // Cleanup success
    await redis
      .multi()
      .zrem(ZSET_KEY, jobId)
      .del(jobKey)
      .del(buildLockKey(jobId))
      .del(buildAttemptsKey(jobId))
      .exec();

    console.log(`[SCHED] ${jobId} processed. Order ID: ${orderId || "N/A"}`);
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;

    console.error(`[SCHED] Error processing ${jobId}:`, err?.message);
    if (status) {
      console.error("[SCHED] HTTP:", status);
      console.error("[SCHED] Response body:", body);
    }

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
