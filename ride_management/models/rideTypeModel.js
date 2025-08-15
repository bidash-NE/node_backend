// models/rideTypeModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

// Helper functions to sanitize values for DB
function toDbIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toDbStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Function to get Bhutan time (Asia/Thimphu)
function getBhutanTime() {
  return moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");
}

// Insert into admin_logs (with Bhutan's time for created_at)
async function logAdmin(conn, userId, adminName, activity) {
  const createdAt = getBhutanTime(); // Get Bhutan time when creating the log
  const sql = `INSERT INTO admin_logs (user_id, admin_name, activity, created_at) VALUES (?, ?, ?, ?)`;
  await conn.query(sql, [
    toDbIntOrNull(userId),
    toDbStrOrNull(adminName),
    toDbStrOrNull(activity),
    createdAt,
  ]);
}

const createRideType = async (
  { name, base_fare, per_km, per_min, image = null },
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
      `INSERT INTO ride_types (name, image, base_fare, per_km, per_min) VALUES (?, ?, ?, ?, ?)`,
      [name, image || null, base_fare, per_km, per_min]
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
  const { name, base_fare, per_km, per_min, image = null } = data;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `UPDATE ride_types
         SET name = ?, image = ?, base_fare = ?, per_km = ?, per_min = ?
       WHERE ride_type_id = ?`,
      [name, image || null, base_fare, per_km, per_min, id]
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
      `SELECT name, image FROM ride_types WHERE ride_type_id = ?`,
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
    return {
      affectedRows: result.affectedRows,
      deletedImage: existing?.image || null,
    };
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
