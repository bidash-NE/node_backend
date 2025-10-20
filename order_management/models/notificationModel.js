// models/notificationModel.js
const db = require("../config/db");

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertPositiveInt(n, name) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertUuid(id) {
  if (!UUID_RX.test(String(id))) throw new Error("notification_id is invalid");
}

const NotificationModel = {
  /**
   * List notifications for a business.
   * @param {object} opts
   * @param {number} opts.business_id
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @param {boolean} [opts.unreadOnly=false]
   */
  async listByBusinessId({
    business_id,
    limit = 50,
    offset = 0,
    unreadOnly = false,
  }) {
    assertPositiveInt(business_id, "business_id");
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    offset = Math.max(parseInt(offset, 10) || 0, 0);

    const where = ["business_id = ?"];
    const params = [business_id];

    if (unreadOnly) {
      where.push("is_read = 0");
    }

    const sql = `
      SELECT
        notification_id,
        order_id,
        business_id,
        user_id,
        type,
        title,
        body_preview,
        is_read,
        created_at,
        delivered_at,
        seen_at
      FROM order_notification
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(sql, params);
    return rows || [];
  },

  /**
   * Get one notification by UUID.
   */
  async getById(notification_id) {
    assertUuid(notification_id);
    const [rows] = await db.query(
      `
      SELECT
        notification_id,
        order_id,
        business_id,
        user_id,
        type,
        title,
        body_preview,
        is_read,
        created_at,
        delivered_at,
        seen_at
      FROM order_notification
      WHERE notification_id = ?
      LIMIT 1`,
      [notification_id]
    );
    return rows?.[0] || null;
  },

  /**
   * Mark a single notification as read.
   * Sets is_read=1 and seen_at=NOW().
   */
  async markAsRead(notification_id) {
    assertUuid(notification_id);
    const [r] = await db.query(
      `UPDATE order_notification
         SET is_read = 1,
             seen_at = NOW()
       WHERE notification_id = ?`,
      [notification_id]
    );
    return r.affectedRows;
  },

  /**
   * Mark all notifications for a business as read.
   */
  async markAllAsRead(business_id) {
    assertPositiveInt(business_id, "business_id");
    const [r] = await db.query(
      `UPDATE order_notification
         SET is_read = 1,
             seen_at = COALESCE(seen_at, NOW())
       WHERE business_id = ?
         AND is_read = 0`,
      [business_id]
    );
    return r.affectedRows;
  },

  /**
   * Delete one notification by UUID.
   */
  async deleteById(notification_id) {
    assertUuid(notification_id);
    const [r] = await db.query(
      `DELETE FROM order_notification WHERE notification_id = ?`,
      [notification_id]
    );
    return r.affectedRows;
  },
};

module.exports = NotificationModel;
