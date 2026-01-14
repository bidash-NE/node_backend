// controllers/systemNotificationController.js
const {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminlogModel");
const {
  sendNotificationEmails,
} = require("../services/emailNotificationService");
const {
  sendNotificationSmsBulk,
} = require("../services/smsNotificationService");

async function createSystemNotification(req, res) {
  try {
    const {
      user_id,
      user_name,
      title,
      message,
      delivery_channels,
      target_audience,
    } = req.body || {};

    const createdBy = user_id || null;
    const adminName = user_name || "System";

    if (
      !title ||
      !String(title).trim() ||
      !message ||
      !String(message).trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required.",
      });
    }

    if (!Array.isArray(delivery_channels) || delivery_channels.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one delivery channel is required.",
      });
    }

    if (!Array.isArray(target_audience) || target_audience.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one target audience is required.",
      });
    }

    const norm = (s) =>
      String(s || "")
        .trim()
        .toLowerCase();
    const lowerChannels = delivery_channels.map(norm);
    const roles = target_audience
      .map((r) => String(r || "").trim())
      .filter(Boolean);

    const wantsInApp = lowerChannels.includes("in_app");
    const wantsEmail = lowerChannels.includes("email");
    const wantsSms = lowerChannels.includes("sms");

    let notificationId = null;
    let emailSummary = null;
    let smsSummary = null;

    if (wantsInApp) {
      notificationId = await insertSystemNotification({
        title: String(title).trim(),
        message: String(message).trim(),
        deliveryChannels: ["in_app"],
        targetAudience: roles,
        createdBy,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Created IN_APP notification #${notificationId} - "${String(
          title
        ).trim()}" for roles [${roles.join(", ")}]`,
      });
    }

    if (wantsEmail) {
      emailSummary = await sendNotificationEmails({
        notificationId,
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const sent = Number(emailSummary?.sent || 0);
      const failed = Number(emailSummary?.failed || 0);
      const skipped = Number(emailSummary?.skipped || 0);
      const total =
        emailSummary?.total != null
          ? Number(emailSummary.total)
          : sent + failed + skipped;

      let logMessage = `Sent EMAIL notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, skipped: ${skipped}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    if (wantsSms) {
      smsSummary = await sendNotificationSmsBulk({
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const total = Number(smsSummary?.total || 0);
      const sent = Number(smsSummary?.sent || 0);
      const failed = Number(smsSummary?.failed || 0);
      const batches = Number(smsSummary?.batches || 0);

      let logMessage = `Sent SMS notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, batches: ${batches}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Notification processed successfully.",
      notification_id: notificationId,
      email_summary: emailSummary,
      sms_summary: smsSummary,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

async function getAllSystemNotificationsController(req, res) {
  try {
    const notifications = await getAllSystemNotifications();
    return res.json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

async function getSystemNotificationsByUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    const notifications = await getNotificationsForUserRole(userId);

    return res.json({
      success: true,
      user_id: userId,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

module.exports = {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
};
