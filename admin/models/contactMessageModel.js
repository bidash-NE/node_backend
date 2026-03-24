const db = require("../config/db");

/* =======================================================
   CREATE MESSAGE
======================================================= */
async function createMessage(data) {
  const sql = `
    INSERT INTO contact_messages
    (full_name, contact_type, contact_value, user_type, message)
    VALUES (?, ?, ?, ?, ?)
  `;

  const values = [
    data.full_name,
    data.contact_type,
    data.contact_value,
    data.user_type || null,
    data.message,
  ];

  const [result] = await db.query(sql, values);
  return result.insertId;
}

/* =======================================================
   GET ALL MESSAGES (WITH FILTERS)
======================================================= */
async function getAllMessages(filters = {}) {
  let sql = `SELECT * FROM contact_messages WHERE 1=1`;
  const params = [];

  if (filters.status) {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }

  if (filters.user_type) {
    sql += ` AND user_type = ?`;
    params.push(filters.user_type);
  }

  sql += ` ORDER BY created_at DESC`;

  const [rows] = await db.query(sql, params);
  return rows;
}

/* =======================================================
   GET MESSAGE BY ID
======================================================= */
async function getMessageById(id) {
  const [rows] = await db.query(`SELECT * FROM contact_messages WHERE id = ?`, [
    id,
  ]);
  return rows[0];
}

/* =======================================================
   UPDATE STATUS
======================================================= */
async function updateMessageStatus(id, status) {
  const sql = `
    UPDATE contact_messages
    SET status = ?
    WHERE id = ?
  `;

  const [result] = await db.query(sql, [status, id]);
  return result.affectedRows;
}

/* =======================================================
   DELETE MESSAGE
======================================================= */
async function deleteMessage(id) {
  const [result] = await db.query(`DELETE FROM contact_messages WHERE id = ?`, [
    id,
  ]);
  return result.affectedRows;
}

module.exports = {
  createMessage,
  getAllMessages,
  getMessageById,
  updateMessageStatus,
  deleteMessage,
};
