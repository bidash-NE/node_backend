const db = require("../config/db");

const NotificationModel = {
  async getAllByUserId(userId) {
    const [rows] = await db.query(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC",
      [userId]
    );
    return rows;
  },

  async getLatestTenByUserId(userId) {
    const [rows] = await db.query(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
      [userId]
    );
    return rows;
  },

  async getUnreadByUserId(userId) {
    const [rows] = await db.query(
      "SELECT * FROM notifications WHERE user_id = ? AND status = 'unread' ORDER BY created_at DESC",
      [userId]
    );
    return rows;
  },

  async markAllAsRead(userId) {
    const [result] = await db.query(
      "UPDATE notifications SET status = 'read' WHERE user_id = ? AND status = 'unread'",
      [userId]
    );
    return result.affectedRows;
  },

  async create(notification) {
    const { user_id, type, title, message, data } = notification;
    const [result] = await db.query(
      "INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)",
      [user_id, type, title, message, JSON.stringify(data)]
    );
    return result.insertId;
  },

  // Get a single notification by ID
  async getById(id) {
    const [rows] = await db.query("SELECT * FROM notifications WHERE id = ?", [
      id,
    ]);
    return rows[0]; // Return the first match or undefined
  },

  // Mark as read if currently unread
  async markOneAsRead(id) {
    const [result] = await db.query(
      "UPDATE notifications SET status = 'read' WHERE id = ? AND status = 'unread'",
      [id]
    );
    return result.affectedRows;
  },
};

module.exports = NotificationModel;
