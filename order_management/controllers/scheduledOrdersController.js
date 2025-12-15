// controllers/scheduledOrdersController.js
const db = require("../config/db");
const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
  parseScheduledToEpochMs,
  epochToBhutanIso,
} = require("../models/scheduledOrderModel");

const ALLOWED_SERVICE_TYPES = new Set(["FOOD", "MART"]);

exports.scheduleOrder = async (req, res) => {
  try {
    const { user_id, scheduled_at, ...orderPayload } = req.body;

    const userId = Number(user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id is required and must be a number.",
      });
    }

    if (!scheduled_at) {
      return res
        .status(400)
        .json({ success: false, message: "scheduled_at is required." });
    }

    // ✅ Bhutan-correct parsing (no timezone => treat as Bhutan local)
    const epochMs = parseScheduledToEpochMs(scheduled_at);
    if (!Number.isFinite(epochMs)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid scheduled_at format. Use ISO with +06:00 or without timezone for Bhutan local.",
      });
    }

    if (epochMs <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled time must be in the future.",
      });
    }

    if (!orderPayload.items || !Array.isArray(orderPayload.items) || !orderPayload.items.length) {
      return res.status(400).json({
        success: false,
        message: "Order items are required.",
      });
    }

    // ✅ service_type validation
    const serviceType = String(orderPayload.service_type || "")
      .trim()
      .toUpperCase();

    if (!serviceType || !ALLOWED_SERVICE_TYPES.has(serviceType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    orderPayload.service_type = serviceType;

    const saved = await addScheduledOrder(scheduled_at, orderPayload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,

      // ✅ show BOTH
      scheduled_at_utc: saved.scheduled_at, // machine UTC
      scheduled_at_local: saved.scheduled_at_local, // Bhutan wall clock +06:00

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

exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id parameter." });
    }

    const list = await getScheduledOrdersByUser(userId);

    // Latest first
    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0)
    );

    const mapped = sorted.map((job) => ({
      job_id: job.job_id,
      user_id: job.user_id,
      business_id: job.business_id ?? null,

      scheduled_at_utc: job.scheduled_at ?? null,
      scheduled_at_local:
        job.scheduled_at_local ??
        (Number.isFinite(job.scheduled_epoch_ms)
          ? epochToBhutanIso(job.scheduled_epoch_ms)
          : null),

      created_at_utc: job.created_at ?? null,

      order_payload: job.order_payload,
    }));

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("listScheduledOrders error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

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

    if (!list.length) return res.json({ success: true, data: [] });

    const userIds = [
      ...new Set(
        list
          .map((j) => j.user_id)
          .filter((uid) => uid != null && Number.isFinite(Number(uid)))
          .map((x) => Number(x))
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

    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0)
    );

    const mapped = sorted.map((job) => {
      const uid = Number(job.user_id);
      return {
        job_id: job.job_id,
        user_id: job.user_id,
        name: userNameById.get(uid) || null,
        business_id: job.business_id ?? null,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        created_at_utc: job.created_at ?? null,

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

    return res.json({
      success: true,
      message: "Scheduled order cancelled.",
    });
  } catch (err) {
    console.error("cancelScheduledOrder error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
