// controllers/systemNotificationController.js
const {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminLogModel");
const {
  sendNotificationEmails,
} = require("../services/emailNotificationService");

/* ---------------------------------------------------
   POST /api/system-notifications
   Create & send notification

   Rules:
   - If "in_app" is selected  -> save in system_notifications
   - If "email"/"sms" selected -> DO NOT save in system_notifications,
                                 only send + log in admin_logs
--------------------------------------------------- */
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

    if (!title || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Title and message are required." });
    }

    if (!Array.isArray(delivery_channels) || !delivery_channels.length) {
      return res.status(400).json({
        success: false,
        message: "At least one delivery channel is required.",
      });
    }

    if (!Array.isArray(target_audience) || !target_audience.length) {
      return res.status(400).json({
        success: false,
        message: "At least one target audience is required.",
      });
    }

    const lowerChannels = delivery_channels.map((c) => String(c).toLowerCase());
    const wantsInApp = lowerChannels.includes("in_app");
    const wantsEmail = lowerChannels.includes("email");
    const wantsSms = lowerChannels.includes("sms"); // just log for now

    let notificationId = null;
    let emailSummary = null;

    // 1️⃣ In-app: save to system_notifications
    if (wantsInApp) {
      notificationId = await insertSystemNotification({
        title,
        message,
        deliveryChannels: ["in_app"], // store only in_app here
        targetAudience: target_audience,
        createdBy,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Created IN_APP notification #${notificationId} - "${title}" for roles [${target_audience.join(
          ", "
        )}]`,
      });
    }

    // 2️⃣ Email: DO NOT save in system_notifications, only send + log
    if (wantsEmail) {
      emailSummary = await sendNotificationEmails({
        notificationId: notificationId, // may be null if no in_app
        title,
        message,
        roles: target_audience,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Sent EMAIL notification (notification_id=${
          notificationId || "N/A"
        }) to roles [${target_audience.join(", ")}] -> sent=${
          emailSummary.sent
        }, failed=${emailSummary.failed}`,
      });
    }

    // 3️⃣ SMS: only log (no actual SMS sending implemented yet)
    if (wantsSms) {
      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Requested SMS notification (notification_id=${
          notificationId || "N/A"
        }) to roles [${target_audience.join(
          ", "
        )}] (SMS sending not yet implemented)`,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Notification processed successfully.",
      notification_id: notificationId, // may be null if no in_app
      email_summary: emailSummary,
    });
  } catch (err) {
    console.error("❌ Error creating notification:", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
}

/* ---------------------------------------------------
   GET /api/system-notifications/all  (Admin)
   Only returns IN_APP notifications saved in DB
--------------------------------------------------- */
async function getAllSystemNotificationsController(req, res) {
  try {
    const notifications = await getAllSystemNotifications();
    res.json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error("❌ Error fetching all notifications:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/* ---------------------------------------------------
   GET /api/system-notifications/user/:userId  (App)
   Only IN_APP notifications (based on role)
--------------------------------------------------- */
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
    res.json({
      success: true,
      user_id: userId,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error("❌ Error fetching user notifications:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
}

module.exports = {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
};
