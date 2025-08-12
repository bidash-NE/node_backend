const db = require("../config/db");

// Helpers to sanitize values for DB
function toDbIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toDbStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Insert into admin_logs
async function logAdmin(conn, userId, adminName, activity) {
  const sql = `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`;
  await conn.query(sql, [
    toDbIntOrNull(userId),
    toDbStrOrNull(adminName),
    toDbStrOrNull(activity),
  ]);
}

const createRideType = async (
  { name, base_fare, per_km, per_min },
  actorUserId = null,
  adminName = null
) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT ride_type_id FROM ride_types WHERE name = ?`,
      [name]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return { exists: true };
    }

    const [result] = await conn.query(
      `INSERT INTO ride_types (name, base_fare, per_km, per_min) VALUES (?, ?, ?, ?)`,
      [name, base_fare, per_km, per_min]
    );

    await logAdmin(
      conn,
      actorUserId,
      adminName,
      `Created ride type "${name}" (id: ${result.insertId})`
    );

    await conn.commit();
    return { created: true, insertId: result.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const updateRideType = async (
  id,
  data,
  actorUserId = null,
  adminName = null
) => {
  const { name, base_fare, per_km, per_min } = data;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `UPDATE ride_types SET name = ?, base_fare = ?, per_km = ?, per_min = ? WHERE ride_type_id = ?`,
      [name, base_fare, per_km, per_min, id]
    );

    if (result.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Updated ride type (id: ${id}) -> name="${name}", base_fare=${base_fare}, per_km=${per_km}, per_min=${per_min}`
      );
    }

    await conn.commit();
    return result.affectedRows;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const getRideTypes = async () => {
  const [rows] = await db.query(`SELECT * FROM ride_types`);
  return rows;
};

const getRideTypeById = async (id) => {
  const [rows] = await db.query(
    `SELECT * FROM ride_types WHERE ride_type_id = ?`,
    [id]
  );
  return rows[0];
};

const deleteRideType = async (
  ride_type_id,
  actorUserId = null,
  adminName = null
) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      `SELECT name FROM ride_types WHERE ride_type_id = ?`,
      [ride_type_id]
    );

    const [result] = await conn.query(
      `DELETE FROM ride_types WHERE ride_type_id = ?`,
      [ride_type_id]
    );

    if (result.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Deleted ride type "${
          existing?.name || "(unknown)"
        }" (id: ${ride_type_id})`
      );
    }

    await conn.commit();
    return result.affectedRows;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = {
  createRideType,
  updateRideType,
  getRideTypes,
  getRideTypeById,
  deleteRideType,
};
