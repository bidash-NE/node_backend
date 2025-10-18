const pool = require("../config/db");
const DriverMongo = require("../models/driverModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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
      [user.user_name, user.email, user.phone, hashedPassword, user.role]
    );
    user_id = userResult.insertId;

    // 2) device (skip for admin)
    if (requiresDevice) {
      const deviceTable =
        user.role === "driver" ? "driver_devices" : "user_devices";
      await connection.query(
        `INSERT INTO ${deviceTable} (user_id, device_id, updated_at) VALUES (?, ?, NOW())`,
        [user_id, deviceID]
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
        ]
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
          docValues.flat()
        );
      }

      // vehicle
      if (vehicle) {
        await connection.query(
          `INSERT INTO driver_vehicles (
            driver_id, make, model, year, color, license_plate, vehicle_type,
            actual_capacity, available_capacity, features, insurance_expiry,code
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
          ]
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

const loginUser = async (req, res) => {
  const { phone, password, role } = req.body || {};

  try {
    // 1) Find by phone
    const [rows] = await pool.query(
      `SELECT user_id, user_name, phone, email, role, password_hash, is_active
       FROM users
       WHERE phone = ?`,
      [phone]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "User with this phone number not found" });
    }

    const user = rows[0];

    // 2) Require active account
    if (Number(user.is_active) !== 1) {
      return res.status(403).json({ error: "Account is deactivated." });
    }

    // 3) Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    // 4) Role allowlist (admin, super admin, user, merchant, driver)
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

    // 5) If merchant, fetch owner_type from merchant_business_details
    let owner_type = null;
    let business_id = null;
    let business_name = null;

    if (user.role === "merchant" || role === "merchant") {
      const [mbd] = await pool.query(
        `SELECT owner_type,business_id, business_name,business_logo,address
           FROM merchant_business_details
          WHERE user_id = ?
          LIMIT 1`,
        [user.user_id]
      );
      if (mbd.length) {
        owner_type = mbd[0]?.owner_type ?? null;
        business_id = mbd[0]?.business_id ?? null;
        business_name = mbd[0]?.business_name ?? null;
        business_logo = mbd[0]?.business_logo ?? null;
        address = mbd[0]?.address ?? null;
      }
    }

    // 6) Issue tokens
    const payload = {
      user_id: user.user_id,
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "1m",
    });

    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "10m",
    });

    // 7) Response (include owner_type if merchant)
    return res.status(200).json({
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 1,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
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

module.exports = {
  registerUser,
  loginUser,
};
