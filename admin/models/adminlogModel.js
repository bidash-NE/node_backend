// models/adminLogModel.js
const pool = require("../config/db");

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

async function addLog({ user_id = null, admin_name = "API", activity }) {
  if (!activity || !String(activity).trim()) return;

  let uid = user_id;

  // ✅ Ensure FK won't fail: if uid not in users table -> set NULL
  if (uid !== null && uid !== undefined) {
    const [rows] = await pool.query(
      "SELECT user_id FROM users WHERE user_id = ? LIMIT 1",
      [uid]
    );
    if (!rows.length) uid = null;
  } else {
    uid = null;
  }

  await pool.query(
    `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`,
    [uid, admin_name, activity]
  );
}

module.exports = { getAll, addLog };
