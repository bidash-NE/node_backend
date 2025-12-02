// controllers/scheduledOrdersController.js

const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
} = require("../models/scheduledOrderModel");

const BHUTAN_TZ = "Asia/Thimphu";

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

    const saved = await addScheduledOrder(scheduledDate, orderPayload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,
      scheduled_at: saved.scheduled_at,
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
      return db - da; // descending
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
      } catch (e) {
        // ignore formatting errors
      }

      // Build response object in desired order
      return {
        job_id: job.job_id,
        user_id: job.user_id,
        business_id: job.business_id ?? null,
        scheduled_at: scheduledLocal, // Bhutan time
        created_at: createdLocal, // Bhutan time
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
 * Return:
 * - scheduled_at and created_at in Bhutan time
 * - items sorted from latest scheduled to earliest
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

    // Sort by scheduled_at DESC (latest first)
    const sorted = [...list].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime();
      const db = new Date(b.scheduled_at).getTime();
      return db - da; // descending
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
      } catch (e) {
        // ignore formatting errors
      }

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
