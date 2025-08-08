const pool = require("../config/db");
const DriverMongo = require("../models/driverModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ✅ Register controller
const registerUser = async (req, res) => {
  let user_id = null;
  let driver_id = null;
  const connection = await pool.getConnection();

  try {
    const { user, driver, documents, vehicle } = req.body;
    console.log(user);
    // 0. Check if deviceID is present, else reject request immediately
    const deviceID = driver?.device_id || req.body.deviceID;

    if (!deviceID) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(user.password, 10);

    // 1. Insert into users table
    const [userResult] = await connection.query(
      `INSERT INTO users (user_name, email, phone, password_hash, is_verified, role) VALUES (?, ?, ?, ?, 1, ?)`,
      [user.user_name, user.email, user.phone, hashedPassword, user.role]
    );
    user_id = userResult.insertId;

    // 2. Insert device info based on role
    const deviceTable =
      user.role === "driver" ? "driver_devices" : "user_devices";
    await connection.query(
      `INSERT INTO ${deviceTable} (user_id, device_id, updated_at) VALUES (?, ?, NOW())`,
      [user_id, deviceID]
    );

    // 3. If driver, insert driver-related tables
    if (user.role === "driver") {
      const [driverResult] = await connection.query(
        `INSERT INTO drivers (
          user_id, license_number, license_expiry, approval_status, is_approved, rating, total_rides, is_online, current_location, current_location_updated_at
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

      // Insert into MongoDB (DriverMongo)
      await DriverMongo.create({
        user_id, // Ensures matching SQL-Mongo mapping
        license_number: driver.license_number,
        license_expiry: driver.license_expiry,
        current_location: driver.current_location,
        current_location_updated_at: new Date(),
        device_id: deviceID,
        actual_capacity: vehicle.capacity,
        available_capacity: vehicle.capacity,
        vehicle_type: vehicle.vehicle_type,
      });

      // Insert driver documents if any
      if (documents?.length > 0) {
        const docValues = documents.map((d) => [
          driver_id,
          d.document_type,
          d.document_url,
        ]);
        const placeholders = docValues.map(() => "(?, ?, ?)").join(", ");
        const flatValues = docValues.flat();
        await connection.query(
          `INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ${placeholders}`,
          flatValues
        );
      }

      // Insert vehicle into MySQL
      if (vehicle) {
        await connection.query(
          `INSERT INTO driver_vehicles (
            driver_id, make, model, year, color, license_plate, vehicle_type, actual_capacity, available_capacity, features, insurance_expiry
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ]
        );
      }
    }

    await connection.commit();

    res.status(201).json({
      message:
        user.role === "driver"
          ? "User and driver registered successfully"
          : "User registered successfully",
      user_id,
    });
  } catch (err) {
    await connection.rollback();
    console.error("Registration error:", err);
    let errorMessage = "Registration failed";

    if (err.code === "ER_DUP_ENTRY") {
      const duplicateFieldMatch = err.sqlMessage.match(/for key '(.+?)'/);
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

// ✅ Login controller using phone & password
const loginUser = async (req, res) => {
  const { phone, password, role } = req.body;

  try {
    const [rows] = await pool.query(`SELECT * FROM users WHERE phone = ?`, [
      phone,
    ]);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "User with this phone number not found" });
    }

    const user = rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    if (user.role !== "admin" && user.role !== role) {
      return res
        .status(403)
        .json({ error: `Role mismatch. Expected: ${user.role}` });
    }

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
