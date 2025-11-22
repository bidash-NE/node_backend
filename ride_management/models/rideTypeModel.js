// models/rideTypeModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

// Helpers
function toDbIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toDbTinyInt(v, fallback = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? (n ? 1 : 0) : fallback;
}
function toDbDec(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toDbStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function getBhutanTime() {
  return moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");
}

// ✅ Only insert log if adminName provided (no fake values)
async function logAdmin(conn, userId, adminName, activity) {
  if (!adminName) return;

  const createdAt = getBhutanTime();
  const sql = `
    INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
    VALUES (?, ?, ?, ?)
  `;
  await conn.query(sql, [
    toDbIntOrNull(userId),
    toDbStrOrNull(adminName),
    toDbStrOrNull(activity),
    createdAt,
  ]);
}

const createRideType = async (
  {
    name,
    code,
    description = null,
    base_fare,
    per_km_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type = null,
    icon_url = null,
    is_active = 1,
  },
  actorUserId = null,
  adminName = null
) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT id FROM ride_types WHERE name = ? OR code = ?`,
      [name, code]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return { exists: true };
    }

    const [result] = await conn.query(
      `
      INSERT INTO ride_types
        (name, code, description, base_fare, per_km_rate, min_fare, cancellation_fee, capacity,
         vehicle_type, icon_url, is_active)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        toDbStrOrNull(name),
        toDbStrOrNull(code),
        toDbStrOrNull(description),
        toDbDec(base_fare),
        toDbDec(per_km_rate),
        toDbDec(min_fare),
        toDbDec(cancellation_fee),
        toDbIntOrNull(capacity) ?? 1,
        toDbStrOrNull(vehicle_type),
        toDbStrOrNull(icon_url),
        toDbTinyInt(is_active, 1),
      ]
    );

    await logAdmin(
      conn,
      actorUserId,
      adminName,
      `Created ride type "${name}" (code: ${code}, id: ${result.insertId})`
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
  const {
    name,
    code,
    description = null,
    base_fare,
    per_km_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type = null,
    icon_url = null,
    is_active = 1,
  } = data;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `
      UPDATE ride_types
         SET name = ?,
             code = ?,
             description = ?,
             base_fare = ?,
             per_km_rate = ?,
             min_fare = ?,
             cancellation_fee = ?,
             capacity = ?,
             vehicle_type = ?,
             icon_url = ?,
             is_active = ?
       WHERE id = ?
      `,
      [
        toDbStrOrNull(name),
        toDbStrOrNull(code),
        toDbStrOrNull(description),
        toDbDec(base_fare),
        toDbDec(per_km_rate),
        toDbDec(min_fare),
        toDbDec(cancellation_fee),
        toDbIntOrNull(capacity) ?? 1,
        toDbStrOrNull(vehicle_type),
        toDbStrOrNull(icon_url),
        toDbTinyInt(is_active, 1),
        id,
      ]
    );

    if (result.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Updated ride type (id: ${id}) -> name="${name}", code="${code}"`
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
  const [rows] = await db.query(`SELECT * FROM ride_types WHERE id = ?`, [id]);
  return rows[0];
};

const deleteRideType = async (id, actorUserId = null, adminName = null) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      `SELECT name, code, icon_url FROM ride_types WHERE id = ?`,
      [id]
    );

    const [result] = await conn.query(`DELETE FROM ride_types WHERE id = ?`, [
      id,
    ]);

    if (result.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Deleted ride type "${existing?.name}" (code: ${existing?.code}, id: ${id})`
      );
    }

    await conn.commit();
    return {
      affectedRows: result.affectedRows,
      deletedIcon: existing?.icon_url || null,
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
