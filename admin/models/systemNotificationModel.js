// models/systemNotificationModel.js
const db = require("../config/db");

/* Verify admin / super admin using user_id + user_name */
async function findAdminByIdAndName(userId, userName) {
  const sql = `
    SELECT user_id, user_name, role
    FROM users
    WHERE user_id = ?
      AND user_name = ?
      AND role IN ('admin', 'super admin')
    LIMIT 1
  `;
  const [rows] = await db.query(sql, [userId, userName]);
  return rows.length ? rows[0] : null;
}

/* Insert a new system notification (immediate send) */
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
    JSON.stringify(deliveryChannels || []),
    JSON.stringify(targetAudience || []),
    createdBy,
    sentAt,
    status,
  ]);

  return result.insertId;
}

/* Get role of a user */
async function getUserRole(userId) {
  const sql = `SELECT role FROM users WHERE user_id = ? LIMIT 1`;
  const [rows] = await db.query(sql, [userId]);
  return rows.length ? rows[0].role : null;
}

/* Fetch notifications for a given role (simplified columns) */
async function getNotificationsForRole(role) {
  if (!role) return [];

  const sql = `
    SELECT
      id,
      title,
      message,
      status,
      created_at
    FROM system_notifications
    WHERE
      JSON_CONTAINS(target_audience, JSON_QUOTE(?))
      AND status = 'sent'
    ORDER BY created_at DESC
  `;

  const [rows] = await db.query(sql, [role]);
  return rows;
}

module.exports = {
  findAdminByIdAndName,
  insertSystemNotification,
  getUserRole,
  getNotificationsForRole,
};
