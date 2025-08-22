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

// ===== existing + updated queries =====

// ✅ Fetch users with role 'user' (now includes profile_image)
async function fetchUsersByRole() {
  const sql = `
    SELECT user_id, user_name, email, phone, is_active, role, profile_image
    FROM users
    WHERE role = 'user'
    ORDER BY user_name ASC
  `;
  const [rows] = await pool.query(sql);
  return rows;
}

// ✅ Fetch drivers with license and vehicle info (now includes profile_image)
async function fetchDrivers() {
  const userQuery = `
    SELECT user_id, user_name, email, phone, is_active, role, profile_image
    FROM users
    WHERE role = 'driver'
    ORDER BY user_name ASC
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
          `SELECT vehicle_id, make, color, license_plate FROM driver_vehicles WHERE driver_id = ?`,
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
        role: user.role,
        profile_image: user.profile_image || null,
        driver_id,
        license_number,
        vehicles,
      };
    })
  );

  return detailedDrivers;
}

// ✅ Fetch admins (admin + superadmin) (now includes profile_image)
async function fetchAdmins() {
  const sql = `
    SELECT user_id, user_name, email, phone, is_active, role, profile_image
    FROM users
    WHERE role IN ('admin', 'superadmin')
    ORDER BY user_name ASC
  `;
  const [rows] = await pool.query(sql);
  return rows;
}

// ===== Merchants list with business details (uses business_logo as profile_image fallback) =====
async function fetchMerchantsWithBusiness() {
  const sql = `
    SELECT
      u.user_id,
      u.user_name,
      u.email,
      u.phone,
      u.is_active,
      u.role,
      COALESCE(u.profile_image, mbd.business_logo) AS profile_image,
      mbd.business_id,
      mbd.business_name,
      mbd.owner_type,
      mbd.business_logo,
      mbd.created_at AS business_created_at,
      mbd.updated_at AS business_updated_at
    FROM users u
    JOIN merchant_business_details mbd
      ON mbd.user_id = u.user_id
    WHERE u.role = 'merchant'
    ORDER BY mbd.created_at DESC, u.user_name ASC
  `;
  const [rows] = await pool.query(sql);
  return rows;
}

// ===== admin ops =====

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
  fetchMerchantsWithBusiness,
  deactivateUser,
  activateUser,
  deleteUser,
};
