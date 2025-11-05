// controllers/systemNotificationController.js
const {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminlogModel");

/* ---------------------------------------------------
   POST /api/system-notifications
   Create a new system notification
--------------------------------------------------- */
async function createSystemNotification(req, res) {
  try {
    const {
      title,
      message,
      delivery_channels,
      target_audience,
      created_by = null,
    } = req.body || {};

    if (!title || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Title and message are required." });
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

    const newId = await insertSystemNotification({
      title,
      message,
      deliveryChannels: delivery_channels,
      targetAudience: target_audience,
      createdBy: created_by,
    });

    await adminLogModel.addLog({
      user_id: created_by,
      admin_name: "System",
      activity: `Created system notification #${newId}`,
    });

    return res.status(201).json({
      success: true,
      message: "Notification created successfully.",
      id: newId,
    });
  } catch (err) {
    console.error("❌ Error creating notification:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/* ---------------------------------------------------
   GET /api/system-notifications/all
   Fetch ALL system notifications (for admin)
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
   GET /api/system-notifications/user/:userId
   Fetch notifications based on user's role
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
