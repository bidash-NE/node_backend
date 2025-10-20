// controllers/notificationController.js
const NotificationModel = require("../models/notificationModel");

/**
 * GET /api/notifications/business/:businessId
 * Query params: limit, offset, unreadOnly=true|false
 */
async function listByBusinessId(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    const limit = req.query.limit;
    const offset = req.query.offset;
    const unreadOnly =
      String(req.query.unreadOnly || "false").toLowerCase() === "true";

    const data = await NotificationModel.listByBusinessId({
      business_id,
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
    const row = await NotificationModel.getById(id);
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
    const affected = await NotificationModel.markAsRead(id);
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
 * PATCH /api/notifications/business/:businessId/read-all
 * Marks all unread for the business as read.
 */
async function markAllReadForBusiness(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    const affected = await NotificationModel.markAllAsRead(business_id);
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
    const affected = await NotificationModel.deleteById(id);
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
  listByBusinessId,
  getOne,
  markOneRead,
  markAllReadForBusiness,
  deleteOne,
};
