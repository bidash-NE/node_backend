// models/adminLogModel.js
const pool = require("../config/db");

/** Return ALL admin logs (latest first). */
async function getAll() {
  const sql = `
    SELECT
      al.log_id,
      al.user_id,
      al.admin_name,
      al.activity,
      al.created_at
    FROM admin_logs al
    ORDER BY al.created_at DESC, al.log_id DESC
  `;
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(sql);
    return rows;
  } finally {
    conn.release();
  }
}

/** Add new admin log */
/**
 * Save a descriptive activity log.
 * @param {Object} log
 * @param {number} log.user_id
 * @param {string} log.admin_name
 * @param {string} log.activity
 */
async function addLog({ user_id = null, admin_name = "API", activity }) {
  if (!activity || !String(activity).trim()) return;
  await pool.query(
    `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`,
    [user_id, admin_name, activity]
  );
}

module.exports = { getAll, addLog };
