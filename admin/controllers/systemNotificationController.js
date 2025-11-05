// controllers/systemNotificationController.js
const {
  findAdminByIdAndName,
  insertSystemNotification,
  getUserRole,
  getNotificationsForRole,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminLogModel");

/* POST: create system notification */
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

    if (!user_id || !user_name) {
      return res.status(401).json({
        success: false,
        message: "user_id and user_name are required for admin verification.",
      });
    }

    const admin = await findAdminByIdAndName(user_id, user_name);
    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Only admin / super admin can create notifications.",
      });
    }

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required.",
      });
    }

    if (!Array.isArray(delivery_channels) || delivery_channels.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one delivery channel.",
      });
    }

    if (!Array.isArray(target_audience) || target_audience.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Select at least one target audience role.",
      });
    }

    const newId = await insertSystemNotification({
      title,
      message,
      deliveryChannels: delivery_channels,
      targetAudience: target_audience,
      createdBy: admin.user_id,
    });

    const adminName = admin.user_name || `user_${admin.user_id}`;
    const activity = `Created system notification #${newId} - "${title}"`;

    await adminLogModel.addLog({
      user_id: admin.user_id,
      admin_name: adminName,
      activity,
    });

    return res.status(201).json({
      success: true,
      message: "Notification created successfully.",
      notification_id: newId,
    });
  } catch (err) {
    console.error("❌ Error creating notification:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
}

/* GET: fetch notifications by userId */
async function getSystemNotificationsForUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required in params.",
      });
    }

    const role = await getUserRole(userId);
    if (!role) {
      return res.status(404).json({
        success: false,
        message: "User not found or has no role.",
      });
    }

    const notifications = await getNotificationsForRole(role);

    return res.json({
      success: true,
      role,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
}

module.exports = {
  createSystemNotification,
  getSystemNotificationsForUser,
};
