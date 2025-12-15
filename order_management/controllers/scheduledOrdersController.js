// controllers/scheduledOrdersController.js
const db = require("../config/db");
const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
} = require("../models/scheduledOrderModel");

const BHUTAN_TZ = "Asia/Thimphu";
const ALLOWED_SERVICE_TYPES = new Set(["FOOD", "MART"]);
const ALLOWED_PAYMENT_METHODS = new Set(["WALLET", "COD", "CARD"]);

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function sumItemDeliveryFees(items) {
  return items.reduce((s, it) => s + Number(it?.delivery_fee || 0), 0);
}

function sumSubtotals(items) {
  return items.reduce((s, it) => s + Number(it?.subtotal || 0), 0);
}

function normalizeAndFillOrderPayload(rawPayload) {
  const payload = { ...(rawPayload || {}) };
  const items = Array.isArray(payload.items) ? payload.items : [];

  // service_type
  const serviceType = String(payload.service_type || "")
    .trim()
    .toUpperCase();
  payload.service_type = serviceType;

  // payment_method
  const pm = String(payload.payment_method || "")
    .trim()
    .toUpperCase();
  payload.payment_method = pm;

  // fulfillment_type
  payload.fulfillment_type = String(payload.fulfillment_type || "Delivery");

  // discount/platform/delivery/total (must exist for createOrder)
  if (payload.discount_amount == null) payload.discount_amount = 0;
  if (payload.platform_fee == null) payload.platform_fee = 0;

  // delivery_fee: if missing, try compute from items.delivery_fee
  if (payload.delivery_fee == null) {
    const computed = sumItemDeliveryFees(items);
    payload.delivery_fee = computed; // ok even if 0
  }

  // total_amount: if missing, compute (subtotals + delivery_fee - discount)
  if (payload.total_amount == null) {
    const sub = sumSubtotals(items);
    const delivery = Number(payload.delivery_fee || 0);
    const discount = Number(payload.discount_amount || 0);
    payload.total_amount = Number((sub + delivery - discount).toFixed(2));
  }

  // status: always store PENDING
  payload.status = "PENDING";

  // Ensure delivery address for Delivery
  if (payload.fulfillment_type === "Delivery") {
    const addr = payload.delivery_address;
    const addrStr = isObj(addr)
      ? String(addr.address || "").trim()
      : String(addr || "").trim();

    if (!addrStr) {
      return {
        ok: false,
        message: "delivery_address is required for Delivery",
      };
    }
  } else if (payload.fulfillment_type === "Pickup") {
    // allow string or object, but keep as-is
    if (payload.delivery_address == null) payload.delivery_address = "";
  }

  // item validation (match createOrder required fields)
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
        return { ok: false, message: `Item[${idx}] missing ${f}` };
      }
    }
  }

  // numeric validation (match createOrder expectations)
  const deliveryFee = Number(payload.delivery_fee);
  const platformFee = Number(payload.platform_fee);

  if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
    return { ok: false, message: "Invalid delivery_fee" };
  }
  if (!Number.isFinite(platformFee) || platformFee < 0) {
    return { ok: false, message: "Invalid platform_fee" };
  }

  return { ok: true, payload };
}

/**
 * POST /api/scheduled-orders
 * Body: normal order JSON + scheduled_at
 */
exports.scheduleOrder = async (req, res) => {
  try {
    const { user_id, scheduled_at, ...orderPayloadRaw } = req.body || {};

    const userId = Number(user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id is required and must be a valid number.",
      });
    }

    if (!scheduled_at) {
      return res
        .status(400)
        .json({ success: false, message: "scheduled_at is required." });
    }

    const scheduledDate = new Date(scheduled_at);
    if (Number.isNaN(scheduledDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid scheduled_at format.",
      });
    }

    if (scheduledDate <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled time must be in the future.",
      });
    }

    // items required
    if (
      !orderPayloadRaw.items ||
      !Array.isArray(orderPayloadRaw.items) ||
      !orderPayloadRaw.items.length
    ) {
      return res.status(400).json({
        success: false,
        message: "Order items are required.",
      });
    }

    // service_type validation
    const serviceType = String(orderPayloadRaw.service_type || "")
      .trim()
      .toUpperCase();

    if (!serviceType || !ALLOWED_SERVICE_TYPES.has(serviceType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    // payment_method validation
    const payMethod = String(orderPayloadRaw.payment_method || "")
      .trim()
      .toUpperCase();

    if (!payMethod || !ALLOWED_PAYMENT_METHODS.has(payMethod)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid or missing payment_method. Allowed: WALLET, COD, CARD",
      });
    }

    // normalize + fill required fields to match createOrder
    const norm = normalizeAndFillOrderPayload({
      ...orderPayloadRaw,
      service_type: serviceType,
      payment_method: payMethod,
    });

    if (!norm.ok) {
      return res.status(400).json({ success: false, message: norm.message });
    }

    const saved = await addScheduledOrder(scheduledDate, norm.payload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,
      scheduled_at: saved.scheduled_at,
      service_type: saved.order_payload?.service_type || serviceType,
    });
  } catch (err) {
    console.error("scheduleOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

/**
 * GET /api/scheduled-orders/:user_id
 */
exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id parameter." });
    }

    const list = await getScheduledOrdersByUser(userId);

    const sorted = [...list].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime();
      const dbt = new Date(b.scheduled_at).getTime();
      return dbt - da;
    });

    const mapped = sorted.map((job) => {
      let scheduledLocal = null;
      let createdLocal = null;

      try {
        if (job.scheduled_at) {
          const d = new Date(job.scheduled_at);
          scheduledLocal = d.toLocaleString("en-GB", {
            timeZone: BHUTAN_TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
        if (job.created_at) {
          const d = new Date(job.created_at);
          createdLocal = d.toLocaleString("en-GB", {
            timeZone: BHUTAN_TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
      } catch {}

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        business_id: job.business_id ?? null,
        scheduled_at: scheduledLocal,
        created_at: createdLocal,
        order_payload: job.order_payload,
      };
    });

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrders error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

/**
 * GET /api/scheduled-orders/business/:businessId
 */
exports.listScheduledOrdersByBusiness = async (req, res) => {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId) || businessId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid businessId parameter.",
      });
    }

    const list = await getScheduledOrdersByBusiness(businessId);

    if (!list.length) {
      return res.json({ success: true, data: [] });
    }

    const userIds = [
      ...new Set(
        list
          .map((j) => j.user_id)
          .filter((uid) => uid != null && !Number.isNaN(Number(uid)))
      ),
    ];

    let userNameById = new Map();
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");
      const [rows] = await db.query(
        `SELECT user_id, user_name FROM users WHERE user_id IN (${placeholders})`,
        userIds
      );
      userNameById = new Map(rows.map((r) => [Number(r.user_id), r.user_name]));
    }

    const sorted = [...list].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime();
      const dbt = new Date(b.scheduled_at).getTime();
      return dbt - da;
    });

    const mapped = sorted.map((job) => {
      let scheduledLocal = null;
      let createdLocal = null;

      try {
        if (job.scheduled_at) {
          const d = new Date(job.scheduled_at);
          scheduledLocal = d.toLocaleString("en-GB", {
            timeZone: BHUTAN_TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
        if (job.created_at) {
          const d = new Date(job.created_at);
          createdLocal = d.toLocaleString("en-GB", {
            timeZone: BHUTAN_TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
      } catch {}

      const uid = Number(job.user_id);
      const name = userNameById.get(uid) || null;

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        name,
        business_id: job.business_id ?? null,
        scheduled_at: scheduledLocal,
        created_at: createdLocal,
        order_payload: job.order_payload,
      };
    });

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrdersByBusiness error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

/**
 * DELETE /api/scheduled-orders/:user_id/:jobId
 */
exports.cancelScheduledOrder = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const jobId = req.params.jobId;

    if (!Number.isFinite(userId) || userId <= 0 || !jobId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id or jobId.",
      });
    }

    const ok = await cancelScheduledOrderForUser(jobId, userId);
    if (!ok) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found for this user.",
      });
    }

    return res.json({ success: true, message: "Scheduled order cancelled." });
  } catch (err) {
    console.error("cancelScheduledOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
