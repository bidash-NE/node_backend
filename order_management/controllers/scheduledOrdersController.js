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

/**
 * POST /api/scheduled-orders
 * Body: normal order JSON + scheduled_at
 */
exports.scheduleOrder = async (req, res) => {
  try {
    const { user_id, scheduled_at, ...orderPayload } = req.body;

    const userId = Number(user_id);
    if (!userId) {
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

    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
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

    if (!orderPayload.items || !orderPayload.items.length) {
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

    // Normalize stored payload
    orderPayload.service_type = serviceType;

    const saved = await addScheduledOrder(scheduledDate, orderPayload, userId);

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
 * Return:
 * - scheduled_at and created_at in Bhutan time
 * - items sorted from latest scheduled to earliest
 */
exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id parameter." });
    }

    const list = await getScheduledOrdersByUser(userId);

    // Sort by scheduled_at DESC (latest first)
    const sorted = [...list].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime();
      const db = new Date(b.scheduled_at).getTime();
      return db - da;
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
      } catch (e) {}

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        business_id: job.business_id ?? null,
        scheduled_at: scheduledLocal,
        created_at: createdLocal,
        order_payload: job.order_payload,
      };
    });

    return res.json({
      success: true,
      data: mapped,
    });
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
    if (!businessId) {
      return res.status(400).json({
        success: false,
        message: "Invalid businessId parameter.",
      });
    }

    const list = await getScheduledOrdersByBusiness(businessId);

    if (!list.length) {
      return res.json({
        success: true,
        data: [],
      });
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
      const db = new Date(b.scheduled_at).getTime();
      return db - da;
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
      } catch (e) {}

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

    return res.json({
      success: true,
      data: mapped,
    });
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

    if (!userId || !jobId) {
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
