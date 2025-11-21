// models/rideTypeModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

// Helper functions to sanitize values for DB
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

// Function to get Bhutan time (Asia/Thimphu)
function getBhutanTime() {
  return moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");
}

// Insert into admin_logs (with Bhutan's time for created_at)
async function logAdmin(conn, userId, adminName, activity) {
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
        (name, code, description, base_fare, per_km_rate, min_fare, cancellation_fee, capacity, vehicle_type, icon_url, is_active)
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
      `Added ride type "${name}" (code: ${code}, id: ${result.insertId}) base_fare=${base_fare}, per_km_rate=${per_km_rate}, min_fare=${min_fare}, cancellation_fee=${cancellation_fee}, capacity=${capacity}`
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
       WHERE ride_type_id = ?
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
        `Updated ride type (id: ${id}) -> name="${name}", code="${code}", base_fare=${base_fare}, per_km_rate=${per_km_rate}, min_fare=${min_fare}, cancellation_fee=${cancellation_fee}, capacity=${capacity}, vehicle_type="${vehicle_type}", is_active=${is_active}`
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
      `SELECT name, code, icon_url FROM ride_types WHERE ride_type_id = ?`,
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
        `Deleted ride type "${existing?.name || "(unknown)"}" (code: ${
          existing?.code || "(unknown)"
        }, id: ${ride_type_id})`
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
