// models/adminCollaboratorModel.js
const db = require("../config/db");

function toDbRow(payload = {}) {
  const { full_name, contact, email, service, role, current_address, cid } =
    payload;
  return { full_name, contact, email, service, role, current_address, cid };
}

async function create(collab) {
  const row = toDbRow(collab);
  const [res] = await db.query(
    `INSERT INTO admin_collaborators
      (full_name, contact, email, service, role, current_address, cid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.full_name,
      row.contact,
      row.email,
      row.service,
      row.role,
      row.current_address,
      row.cid,
    ]
  );
  return findById(res.insertId);
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT * FROM admin_collaborators WHERE collaborator_id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function existsByEmailOrCid(email, cid, excludeId = null) {
  const params = [email, cid];
  let sql = `SELECT collaborator_id FROM admin_collaborators WHERE (email = ? OR cid = ?)`;
  if (excludeId) {
    sql += ` AND collaborator_id <> ?`;
    params.push(excludeId);
  }
  sql += ` LIMIT 1`;
  const [rows] = await db.query(sql, params);
  return !!rows.length;
}

async function list() {
  const [rows] = await db.query(
    `SELECT * FROM admin_collaborators ORDER BY created_at DESC`
  );
  return { data: rows, total: rows.length };
}

async function updateById(id, changes) {
  const row = toDbRow(changes);
  const fields = [];
  const values = [];
  Object.entries(row).forEach(([k, v]) => {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  });
  if (!fields.length) return findById(id);

  const sql = `UPDATE admin_collaborators SET ${fields.join(
    ", "
  )} WHERE collaborator_id = ?`;
  await db.query(sql, [...values, id]);
  return findById(id);
}

async function removeById(id) {
  const [res] = await db.query(
    `DELETE FROM admin_collaborators WHERE collaborator_id = ?`,
    [id]
  );
  return res.affectedRows > 0;
}

module.exports = {
  create,
  findById,
  list,
  updateById,
  removeById,
  existsByEmailOrCid,
};
