// controllers/authController.js
const pool = require("../config/db");
const DriverMongo = require("../models/driverModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

/* ===================== REGISTER ===================== */

const registerUser = async (req, res) => {
  let user_id = null;
  let driver_id = null;
  const connection = await pool.getConnection();

  try {
    const { user, driver, documents, vehicle } = req.body;

    // deviceID may come from driver.device_id or req.body.deviceID
    const deviceID = driver?.device_id ?? req.body.deviceID ?? null;

    // ✅ Require device ID for everyone EXCEPT admins
    const requiresDevice = user?.role !== "admin";
    if (requiresDevice && !deviceID) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(user.password, 10);

    // 1) users
    const [userResult] = await connection.query(
      `INSERT INTO users (user_name, email, phone, password_hash, is_verified, role)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [user.user_name, user.email, user.phone, hashedPassword, user.role],
    );
    user_id = userResult.insertId;

    // 2) device (skip for admin)
    if (requiresDevice) {
      const deviceTable =
        user.role === "driver" ? "driver_devices" : "user_devices";
      await connection.query(
        `INSERT INTO ${deviceTable} (user_id, device_id, updated_at) VALUES (?, ?, NOW())`,
        [user_id, deviceID],
      );
    }

    // 3) driver-only inserts
    if (user.role === "driver") {
      const [driverResult] = await connection.query(
        `INSERT INTO drivers (
          user_id, license_number, license_expiry, approval_status, is_approved,
          rating, total_rides, is_online, current_location, current_location_updated_at
        ) VALUES (?, ?, ?, 'pending', 0, 0, 0, 0, ST_GeomFromText(?, 4326), ?)`,
        [
          user_id,
          driver.license_number,
          driver.license_expiry,
          `POINT(${driver.current_location.coordinates[0]} ${driver.current_location.coordinates[1]})`,
          new Date(),
        ],
      );

      driver_id = driverResult.insertId;

      // Mongo mirror
      await DriverMongo.create({
        user_id,
        license_number: driver.license_number,
        license_expiry: driver.license_expiry,
        current_location: driver.current_location,
        current_location_updated_at: new Date(),
        device_id: deviceID ?? null,
        actual_capacity: vehicle.capacity,
        available_capacity: vehicle.capacity,
        vehicle_type: vehicle.vehicle_type,
      });

      // documents
      if (Array.isArray(documents) && documents.length > 0) {
        const docValues = documents.map((d) => [
          driver_id,
          d.document_type,
          d.document_url,
        ]);
        const placeholders = docValues.map(() => "(?, ?, ?)").join(", ");
        await connection.query(
          `INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ${placeholders}`,
          docValues.flat(),
        );
      }

      // vehicle
      if (vehicle) {
        await connection.query(
          `INSERT INTO driver_vehicles (
            driver_id, make, model, year, color, license_plate, vehicle_type,
            actual_capacity, available_capacity, features, insurance_expiry, code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            driver_id,
            vehicle.make,
            vehicle.model,
            vehicle.year,
            vehicle.color,
            vehicle.license_plate,
            vehicle.vehicle_type,
            vehicle.capacity,
            vehicle.capacity,
            vehicle.features ? vehicle.features.join(",") : null,
            vehicle.insurance_expiry,
            vehicle.code,
          ],
        );
      }
    }

    await connection.commit();

    res.status(201).json({
      message:
        user.role === "driver"
          ? "User and driver registered successfully"
          : user.role === "admin"
            ? "Admin registered successfully"
            : "User registered successfully",
      user_id,
    });
  } catch (err) {
    await connection.rollback();
    console.error("Registration error:", err);
    let errorMessage = "Registration failed";

    if (err.code === "ER_DUP_ENTRY") {
      const duplicateFieldMatch = err.sqlMessage?.match(/for key '(.+?)'/);
      if (duplicateFieldMatch && duplicateFieldMatch[1]) {
        const key = duplicateFieldMatch[1];
        const fieldParts = key.split(".");
        let fieldName = fieldParts.length > 1 ? fieldParts[1] : key;

        switch (fieldName) {
          case "email":
            errorMessage = "Email already exists";
            break;
          case "phone":
            errorMessage = "Phone number already exists";
            break;
          case "license_number":
            errorMessage = "Driver license number already exists";
            break;
          case "license_plate":
            errorMessage = "Vehicle license plate already exists";
            break;
          default:
            errorMessage = `Duplicate entry for ${fieldName}`;
        }
      }

      try {
        if (user_id) {
          await connection.query(`DELETE FROM users WHERE user_id = ?`, [
            user_id,
          ]);
        }
      } catch (delErr) {
        console.error("Error deleting user after duplicate entry:", delErr);
      }

      return res.status(409).json({ error: errorMessage });
    }

    return res
      .status(500)
      .json({ error: err.sqlMessage || err.message || errorMessage });
  } finally {
    connection.release();
  }
};

/* ===================== LOGIN (sets is_verified=1) ===================== */

const loginUser = async (req, res) => {
  const { phone, password, role, device_id } = req.body || {};

  try {
    // ✅ device_id OPTIONAL for now
    const deviceId =
      device_id && String(device_id).trim() ? String(device_id).trim() : null;

    // 1) Find by phone
    const [rows] = await pool.query(
      `SELECT user_id, user_name, phone, email, role, password_hash, is_active, is_verified
       FROM users
       WHERE phone = ?`,
      [phone],
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "User with this phone number not found" });
    }

    const user = rows[0];

    // 2) Enforce active accounts
    if (Number(user.is_active) !== 1) {
      return res.status(403).json({ error: "Account is deactivated." });
    }

    // 3) Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    // 4) Role allowlist
    const allowed = new Set([
      "admin",
      "super admin",
      "user",
      "merchant",
      "driver",
    ]);
    if (!allowed.has(user.role)) {
      return res
        .status(403)
        .json({ error: `Role mismatch. Expected: ${user.role}` });
    }

    // Optional: if client sent a role, enforce it matches DB role
    if (role && role !== user.role) {
      return res
        .status(403)
        .json({ error: `Role mismatch. Expected: ${user.role}` });
    }

    // 5) If merchant, fetch business info
    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (user.role === "merchant" || role === "merchant") {
      const [mbd] = await pool.query(
        `SELECT owner_type, business_id, business_name, business_logo, address
           FROM merchant_business_details
          WHERE user_id = ?
          ORDER BY created_at DESC, business_id DESC
          LIMIT 1`,
        [user.user_id],
      );

      if (mbd.length) {
        owner_type = mbd[0]?.owner_type ?? null;
        business_id = mbd[0]?.business_id ?? null;
        business_name = mbd[0]?.business_name ?? null;
        business_logo = mbd[0]?.business_logo ?? null;
        address = mbd[0]?.address ?? null;
      }
    }

    // ✅ 6) Save device_id for notifications (ONLY if provided)
    if (deviceId) {
      await pool.query(
        `INSERT INTO all_device_ids (user_id, device_id, last_seen)
VALUES (?, ?, NOW())
ON DUPLICATE KEY UPDATE
  device_id = VALUES(device_id),
  last_seen = NOW();
`,
        [user.user_id, deviceId],
      );
    }

    // 7) Mark verified + last_login
    await pool.query(
      `UPDATE users SET is_verified = 1, last_login = NOW() WHERE user_id = ?`,
      [user.user_id],
    );

    // 8) Issue tokens
    const payload = {
      user_id: user.user_id,
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });

    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "10m",
    });

    // 9) Response
    return res.status(200).json({
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
        ...(deviceId ? { device_id: deviceId } : {}),
        ...(user.role === "merchant" || role === "merchant"
          ? { owner_type, business_id, business_name, business_logo, address }
          : {}),
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
};

/* ===================== LOGOUT (sets is_verified=0) ===================== */
/**
 * POST /api/auth/logout
 * Accepts either:
 *  - Authorization via x-access-token (preferred), or
 *  - { user_id } in body (fallback when no auth middleware present)
 */

const logoutUser = async (req, res) => {
  try {
    console.log(
      "➡️ logout hit",
      req.method,
      req.originalUrl,
      req.params,
      new Date().toISOString(),
    );

    const { user_id } = req.params; // expects /logout/:user_id
    const n = Number(user_id);

    if (!Number.isInteger(n) || n <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid or missing user_id param" });
    }

    // ✅ Use the same promise-based pool as in login/register
    const [result] = await pool.query(
      `UPDATE users 
          SET is_verified = 0,
              last_login = NOW()
        WHERE user_id = ?`,
      [n],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({
      message: "Logout successful",
      user_id: n,
      is_verified: 0,
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Logout failed due to server error" });
  }
};

// controllers/authController.js (add this function)

const verifyActiveSession = async (req, res) => {
  const { user_id, device_id } = req.body || {};

  const uid = Number(user_id);
  const deviceId =
    device_id && String(device_id).trim() ? String(device_id).trim() : null;

  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user_id" });
  }

  if (!deviceId) {
    return res
      .status(400)
      .json({ success: false, message: "device_id is required" });
  }

  try {
    // 1) Check user + is_verified
    const [urows] = await pool.query(
      `SELECT user_id, user_name, phone, email, role, is_active, is_verified
         FROM users
        WHERE user_id = ?
        LIMIT 1`,
      [uid],
    );

    if (urows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const user = urows[0];

    if (Number(user.is_active) !== 1) {
      return res
        .status(403)
        .json({ success: false, message: "Account is deactivated." });
    }

    if (Number(user.is_verified) !== 1) {
      return res.status(200).json({ success: false });
    }

    // 2) Check device match in all_device_ids
    const [drows] = await pool.query(
      `SELECT device_id
         FROM all_device_ids
        WHERE user_id = ?
        LIMIT 1`,
      [uid],
    );

    if (drows.length === 0) {
      return res.status(200).json({ success: false });
    }

    const dbDeviceId = drows[0]?.device_id ? String(drows[0].device_id) : null;

    if (!dbDeviceId || dbDeviceId !== deviceId) {
      return res.status(200).json({ success: false });
    }

    // 3) Merchant extras (same as login)
    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (user.role === "merchant") {
      const [mbd] = await pool.query(
        `SELECT owner_type, business_id, business_name, business_logo, address
           FROM merchant_business_details
          WHERE user_id = ?
          ORDER BY created_at DESC, business_id DESC
          LIMIT 1`,
        [uid],
      );

      if (mbd.length) {
        owner_type = mbd[0]?.owner_type ?? null;
        business_id = mbd[0]?.business_id ?? null;
        business_name = mbd[0]?.business_name ?? null;
        business_logo = mbd[0]?.business_logo ?? null;
        address = mbd[0]?.address ?? null;
      }
    }

    // 4) Issue tokens (same payload as login)
    const payload = {
      user_id: user.user_id,
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });

    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "10m",
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
        device_id: deviceId,
        ...(user.role === "merchant"
          ? { owner_type, business_id, business_name, business_logo, address }
          : {}),
      },
    });
  } catch (err) {
    console.error("verifyActiveSession error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  registerUser,
  loginUser, // now sets is_verified=1 + updates last_login
  logoutUser, // sets is_verified=0
  verifyActiveSession,
};
