// models/adminModel.js
const pool = require("../config/db");
const moment = require("moment-timezone");

// ===== helpers =====
function toDbIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toDbStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function bhutanNow() {
  return moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");
}
async function logAdmin(conn, actorUserId, adminName, activity) {
  const sql = `
    INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
    VALUES (?, ?, ?, ?)
  `;
  await conn.query(sql, [
    toDbIntOrNull(actorUserId),
    toDbStrOrNull(adminName),
    toDbStrOrNull(activity),
    bhutanNow(),
  ]);
}

// ===== existing queries =====

// ✅ Fetch users with role 'user'
async function fetchUsersByRole() {
  const sql = `
    SELECT user_name, email, phone, is_active
    FROM users
    WHERE role = 'user'
  `;
  const [rows] = await pool.query(sql);
  return rows;
}

// ✅ Fetch drivers with license and vehicle info
async function fetchDrivers() {
  const userQuery = `
    SELECT user_id, user_name, email, phone, is_active
    FROM users
    WHERE role = 'driver'
  `;
  const [users] = await pool.query(userQuery);

  const detailedDrivers = await Promise.all(
    users.map(async (user) => {
      const [driverRows] = await pool.query(
        `SELECT driver_id, license_number FROM drivers WHERE user_id = ?`,
        [user.user_id]
      );

      const driverInfo = driverRows[0] || {};
      const driver_id = driverInfo.driver_id || null;
      const license_number = driverInfo.license_number || null;

      let vehicles = [];
      if (driver_id) {
        const [vehicleRows] = await pool.query(
          `SELECT make, color, license_plate FROM driver_vehicles WHERE driver_id = ?`,
          [driver_id]
        );
        vehicles = vehicleRows;
      }

      return {
        user_id: user.user_id,
        user_name: user.user_name,
        email: user.email,
        phone: user.phone,
        is_active: user.is_active,
        driver_id,
        license_number,
        vehicles,
      };
    })
  );

  return detailedDrivers;
}

// ✅ Fetch admins (admin + superadmin)
async function fetchAdmins() {
  const sql = `
    SELECT user_id, user_name, email, phone, is_active, role
    FROM users
    WHERE role IN ('admin', 'superadmin')
    ORDER BY user_name ASC
  `;
  const [rows] = await pool.query(sql);
  return rows;
}

// ===== new admin ops =====

async function deactivateUser(user_id, actorUserId = null, adminName = null) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      `SELECT user_id, user_name, is_active FROM users WHERE user_id = ?`,
      [user_id]
    );
    if (!user) {
      await conn.rollback();
      return { notFound: true };
    }

    if (Number(user.is_active) === 0) {
      await conn.commit();
      return { updated: false, already: "deactivated" };
    }

    const [res] = await conn.query(
      `UPDATE users SET is_active = 0 WHERE user_id = ?`,
      [user_id]
    );

    if (res.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Deactivated user "${user.user_name}" (id: ${user_id})`
      );
    }

    await conn.commit();
    return { updated: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function activateUser(user_id, actorUserId = null, adminName = null) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      `SELECT user_id, user_name, is_active FROM users WHERE user_id = ?`,
      [user_id]
    );
    if (!user) {
      await conn.rollback();
      return { notFound: true };
    }

    if (Number(user.is_active) === 1) {
      await conn.commit();
      return { updated: false, already: "active" };
    }

    const [res] = await conn.query(
      `UPDATE users SET is_active = 1 WHERE user_id = ?`,
      [user_id]
    );

    if (res.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Activated user "${user.user_name}" (id: ${user_id})`
      );
    }

    await conn.commit();
    return { updated: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function deleteUser(user_id, actorUserId = null, adminName = null) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      `SELECT user_id, user_name FROM users WHERE user_id = ?`,
      [user_id]
    );
    if (!user) {
      await conn.rollback();
      return { notFound: true };
    }

    const [res] = await conn.query(`DELETE FROM users WHERE user_id = ?`, [
      user_id,
    ]);

    if (res.affectedRows > 0) {
      await logAdmin(
        conn,
        actorUserId,
        adminName,
        `Deleted user "${user.user_name}" (id: ${user_id})`
      );
    }

    await conn.commit();
    return { deleted: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  fetchUsersByRole,
  fetchDrivers,
  fetchAdmins,
  deactivateUser,
  activateUser,
  deleteUser,
};
