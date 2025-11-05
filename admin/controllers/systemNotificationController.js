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

/* CREATE new system notification */
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

    if (!title || !message)
      return res
        .status(400)
        .json({ success: false, message: "Title and message are required." });

    if (!Array.isArray(delivery_channels) || !delivery_channels.length)
      return res
        .status(400)
        .json({ success: false, message: "Delivery channels required." });

    if (!Array.isArray(target_audience) || !target_audience.length)
      return res
        .status(400)
        .json({ success: false, message: "Target audience required." });

    // 1️⃣ Save notification
    const newId = await insertSystemNotification({
      title,
      message,
      deliveryChannels: delivery_channels,
      targetAudience: target_audience,
      createdBy,
    });

    // 2️⃣ Log admin activity
    await adminLogModel.addLog({
      user_id: createdBy,
      admin_name: adminName,
      activity: `Created system notification #${newId} - "${title}"`,
    });

    // 3️⃣ If email selected → send one-by-one with delay
    let emailSummary = null;
    const wantsEmail = delivery_channels
      .map((c) => c.toLowerCase())
      .includes("email");

    if (wantsEmail) {
      emailSummary = await sendNotificationEmails({
        notificationId: newId,
        title,
        message,
        roles: target_audience,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Email sent for notification #${newId}: sent=${emailSummary.sent}, failed=${emailSummary.failed}`,
      });
    }

    res.status(201).json({
      success: true,
      message: "Notification created successfully.",
      id: newId,
      email_summary: emailSummary,
    });
  } catch (err) {
    console.error("❌ Error creating notification:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/* FETCH all notifications (admin panel) */
async function getAllSystemNotificationsController(req, res) {
  try {
    const notifications = await getAllSystemNotifications();
    res.json({ success: true, count: notifications.length, notifications });
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/* FETCH visible notifications for user */
async function getSystemNotificationsByUser(req, res) {
  try {
    const { userId } = req.params;
    if (!userId)
      return res
        .status(400)
        .json({ success: false, message: "User ID is required." });

    const notifications = await getNotificationsForUserRole(userId);
    res.json({ success: true, count: notifications.length, notifications });
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
