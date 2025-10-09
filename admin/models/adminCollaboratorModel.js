// models/adminCollaboratorModel.js
const db = require("../config/db");

function toDbRow(payload = {}) {
  const {
    full_name = undefined,
    contact = undefined,
    email = undefined,
    service = undefined,
    role = undefined,
    current_address = undefined,
    cid = undefined,
  } = payload;
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
    `SELECT collaborator_id, full_name, contact, email, service, role,
            current_address, cid, created_at, updated_at
       FROM admin_collaborators
      WHERE collaborator_id = ?`,
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

async function list({ page = 1, pageSize = 10, q = "" } = {}) {
  page = Math.max(1, Number(page));
  pageSize = Math.min(100, Math.max(1, Number(pageSize)));
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];

  if (q && String(q).trim()) {
    const like = `%${q.trim()}%`;
    where.push(
      `(full_name LIKE ? OR email LIKE ? OR contact LIKE ? OR cid LIKE ? OR service LIKE ? OR role LIKE ?)`
    );
    params.push(like, like, like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT collaborator_id, full_name, contact, email, service, role,
            current_address, cid, created_at, updated_at
       FROM admin_collaborators
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM admin_collaborators ${whereSql}`,
    params
  );

  return {
    data: rows,
    page,
    pageSize,
    total: countRows[0].total,
    totalPages: Math.ceil(countRows[0].total / pageSize),
  };
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
