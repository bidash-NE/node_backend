const NotificationModel = require("../models/notificationModel");

// ✅ Get all notifications
exports.getAllNotifications = async (req, res) => {
  const { userId } = req.params;

  try {
    const notifications = await NotificationModel.getAllByUserId(userId);

    if (!notifications || notifications.length === 0) {
      return res.status(404).json({
        message: `No notifications found for user ID ${userId}`,
        data: [],
      });
    }

    return res.status(200).json({
      message: `Notifications retrieved successfully for user ID ${userId}`,
      data: notifications,
    });
  } catch (error) {
    console.error("❌ Error fetching notifications:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ✅ Get latest 10 notifications
exports.getLatestNotifications = async (req, res) => {
  const { userId } = req.params;

  try {
    const notifications = await NotificationModel.getLatestTenByUserId(userId);

    if (!notifications || notifications.length === 0) {
      return res.status(404).json({
        message: `No recent notifications found for user ID ${userId}`,
        data: [],
      });
    }

    return res.status(200).json({
      message: "Latest notifications retrieved successfully",
      data: notifications,
    });
  } catch (error) {
    console.error("❌ Error fetching latest notifications:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ✅ Create a new notification
exports.createNotification = async (req, res) => {
  const { user_id, type, title, message, data } = req.body;

  if (!user_id || !type || !title || !message) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const insertId = await NotificationModel.create({
      user_id,
      type,
      title,
      message,
      data: data || {},
    });

    return res.status(201).json({
      message: "✅ Notification created successfully",
      notification_id: insertId,
    });
  } catch (error) {
    console.error("❌ Error creating notification:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ✅ Get unread notifications
exports.getUnreadNotifications = async (req, res) => {
  const { userId } = req.params;

  try {
    const unreadNotifications = await NotificationModel.getUnreadByUserId(
      userId
    );

    if (!unreadNotifications || unreadNotifications.length === 0) {
      return res.status(404).json({
        message: `No unread notifications found for user ID ${userId}`,
        data: [],
      });
    }

    return res.status(200).json({
      message: "Unread notifications retrieved successfully",
      data: unreadNotifications,
    });
  } catch (error) {
    console.error("❌ Error fetching unread notifications:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ✅ Mark all unread notifications as read
exports.markAllAsRead = async (req, res) => {
  const { userId } = req.params;

  try {
    const affectedRows = await NotificationModel.markAllAsRead(userId);

    return res.status(200).json({
      message: `${affectedRows} notifications marked as read for user ID ${userId}`,
    });
  } catch (error) {
    console.error("❌ Error updating notifications:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.markOneAsRead = async (req, res) => {
  const { id } = req.params;

  try {
    // Step 1: Fetch the notification by ID
    const notification = await NotificationModel.getById(id);

    if (!notification) {
      return res
        .status(404)
        .json({ message: `Notification with ID ${id} not found` });
    }

    // Step 2: Check if it's already marked as read
    if (notification.status === "read") {
      return res.status(200).json({
        message: `Notification with ID ${id} is already marked as read`,
      });
    }

    // Step 3: Update to 'read'
    const affectedRows = await NotificationModel.markOneAsRead(id);

    if (affectedRows > 0) {
      return res.status(200).json({
        message: `Notification with ID ${id} marked as read successfully`,
      });
    } else {
      return res
        .status(400)
        .json({ message: `Failed to mark notification as read` });
    }
  } catch (error) {
    console.error("❌ Error marking notification as read:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
