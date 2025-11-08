const db = require("../config/db");

function assertPositiveInt(n, name) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

const UserNotificationModel = {
  /**
   * List notifications for a user.
   * @param {object} opts
   * @param {number} opts.user_id
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @param {boolean} [opts.unreadOnly=false]
   */
  async listByUserId({ user_id, limit = 50, offset = 0, unreadOnly = false }) {
    assertPositiveInt(user_id, "user_id");
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    offset = Math.max(parseInt(offset, 10) || 0, 0);

    const where = ["user_id = ?"];
    const params = [user_id];

    if (unreadOnly) {
      where.push("status = 'unread'");
    }

    const sql = `
      SELECT
        id,
        user_id,
        type,
        title,
        message,
        data,
        status,
        created_at
      FROM notifications
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(sql, params);
    return rows || [];
  },

  /**
   * Get one notification by ID.
   */
  async getById(notification_id) {
    const [rows] = await db.query(
      `
      SELECT
        id,
        user_id,
        type,
        title,
        message,
        data,
        status,
        created_at
      FROM notifications
      WHERE id = ? LIMIT 1`,
      [notification_id]
    );
    return rows?.[0] || null;
  },

  /**
   * Mark a single notification as read.
   * Sets status='read' and updates the `created_at` field to the current timestamp.
   */
  async markAsRead(notification_id) {
    const [r] = await db.query(
      `UPDATE notifications
         SET status = 'read',
             created_at = NOW()
       WHERE id = ?`,
      [notification_id]
    );
    return r.affectedRows;
  },

  /**
   * Mark all notifications for a user as read.
   */
  async markAllAsRead(user_id) {
    assertPositiveInt(user_id, "user_id");
    const [r] = await db.query(
      `UPDATE notifications
         SET status = 'read',
             created_at = COALESCE(created_at, NOW())
       WHERE user_id = ?
         AND status = 'unread'`,
      [user_id]
    );
    return r.affectedRows;
  },

  /**
   * Delete one notification by ID.
   */
  async deleteById(notification_id) {
    const [r] = await db.query(`DELETE FROM notifications WHERE id = ?`, [
      notification_id,
    ]);
    return r.affectedRows;
  },
};

module.exports = UserNotificationModel;
