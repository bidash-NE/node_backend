// models/systemNotificationModel.js
const db = require("../config/db");

/**
 * Insert a new IN_APP system notification.
 * (We only store in DB when "in_app" channel is used.)
 */
async function insertSystemNotification(data) {
  const {
    title,
    message,
    deliveryChannels = [],
    targetAudience = [],
    createdBy = null,
  } = data;

  const status = "sent";
  const sentAt = new Date();

  const sql = `
    INSERT INTO system_notifications
      (title, message, delivery_channels, target_audience,
       created_by, sent_at, status)
    VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)
  `;

  const [result] = await db.query(sql, [
    title,
    message,
    JSON.stringify(deliveryChannels),
    JSON.stringify(targetAudience),
    createdBy,
    sentAt,
    status,
  ]);

  return result.insertId;
}

/**
 * Fetch all IN_APP notifications (for admin view).
 */
async function getAllSystemNotifications() {
  const sql = `
    SELECT
      id,
      title,
      message,
      delivery_channels,
      target_audience,
      status,
      sent_at,
      created_at
    FROM system_notifications
    ORDER BY created_at DESC, id DESC
  `;
  const [rows] = await db.query(sql);
  return rows;
}

/**
 * Fetch notifications visible to a user based on their role.
 * Only IN_APP notifications are stored here.
 */
async function getNotificationsForUserRole(userId) {
  if (!userId) return [];

  const sqlRole = `SELECT role FROM users WHERE user_id = ? LIMIT 1`;
  const [roleRows] = await db.query(sqlRole, [userId]);
  if (!roleRows.length) return [];

  const role = roleRows[0].role;

  const sql = `
    SELECT
      id,
      title,
      message,
      status,
      created_at
    FROM system_notifications
    WHERE JSON_CONTAINS(target_audience, JSON_QUOTE(?))
      AND status = 'sent'
    ORDER BY created_at DESC
  `;

  const [rows] = await db.query(sql, [role]);
  return rows;
}

/* ======================================================
   ✅ NEW: Fetch email + phone for a user_id (single user send)
====================================================== */
async function getUserContactById(userId) {
  if (!userId) return null;

  const sql = `
    SELECT user_id, user_name, email, phone, role
    FROM users
    WHERE user_id = ?
    LIMIT 1
  `;
  const [rows] = await db.query(sql, [Number(userId)]);
  return rows.length ? rows[0] : null;
}

module.exports = {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,

  // ✅ NEW export
  getUserContactById,
};
