const UserNotificationModel = require("../models/userNotificationModel");

/**
 * GET /api/notifications/user/:userId
 * Query params: limit, offset, unreadOnly=true|false
 */
async function listByUserId(req, res) {
  try {
    const user_id = Number(req.params.userId);
    const limit = req.query.limit;
    const offset = req.query.offset;
    const unreadOnly =
      String(req.query.unreadOnly || "false").toLowerCase() === "true";

    const data = await UserNotificationModel.listByUserId({
      user_id,
      limit,
      offset,
      unreadOnly,
    });

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    const msg = err.message || "Failed to fetch notifications";
    const code = /must be a positive integer|invalid/.test(msg) ? 400 : 500;
    res.status(code).json({ success: false, error: msg });
  }
}

/**
 * GET /api/notifications/:notificationId
 */
async function getOne(req, res) {
  try {
    const id = req.params.notificationId;
    console.log("Fetching notification with ID:", id);
    const row = await UserNotificationModel.getById(id);
    if (!row)
      return res.status(404).json({ success: false, error: "Not found" });
    res.status(200).json({ success: true, data: row });
  } catch (err) {
    const msg = err.message || "Failed to fetch notification";
    const code = /invalid/.test(msg) ? 400 : 500;
    res.status(code).json({ success: false, error: msg });
  }
}

/**
 * PATCH /api/notifications/:notificationId/read
 * Marks one as read.
 */
async function markOneRead(req, res) {
  try {
    const id = req.params.notificationId;
    const affected = await UserNotificationModel.markAsRead(id);
    if (!affected)
      return res.status(404).json({ success: false, error: "Not found" });
    res.status(200).json({ success: true, message: "Marked as read" });
  } catch (err) {
    const msg = err.message || "Failed to mark as read";
    const code = /invalid/.test(msg) ? 400 : 500;
    res.status(code).json({ success: false, error: msg });
  }
}

/**
 * PATCH /api/notifications/user/:userId/read-all
 * Marks all unread for the user as read.
 */
async function markAllReadForUser(req, res) {
  try {
    const user_id = Number(req.params.userId);
    const affected = await UserNotificationModel.markAllAsRead(user_id);
    res.status(200).json({ success: true, updated: affected });
  } catch (err) {
    const msg = err.message || "Failed to mark all as read";
    const code = /must be a positive integer/.test(msg) ? 400 : 500;
    res.status(code).json({ success: false, error: msg });
  }
}

/**
 * DELETE /api/notifications/:notificationId
 */
async function deleteOne(req, res) {
  try {
    const id = req.params.notificationId;
    const affected = await UserNotificationModel.deleteById(id);
    if (!affected)
      return res.status(404).json({ success: false, error: "Not found" });
    res.status(200).json({ success: true, message: "Deleted" });
  } catch (err) {
    const msg = err.message || "Failed to delete notification";
    const code = /invalid/.test(msg) ? 400 : 500;
    res.status(code).json({ success: false, error: msg });
  }
}

module.exports = {
  listByUserId,
  getOne,
  markOneRead,
  markAllReadForUser,
  deleteOne,
};
