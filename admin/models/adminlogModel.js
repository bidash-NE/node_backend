// models/adminLogModel.js
const pool = require("../config/db");

/**
 * Return ALL admin logs (latest first).
 * Keep it simple as requested—no pagination/filters.
 */
async function getAll() {
  const sql = `
    SELECT
      al.log_id,
      al.user_id,
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

module.exports = { getAll };
