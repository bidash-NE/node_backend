const pool = require("../config/db");

const updateDeviceID = async (req, res) => {
  const { user_id, role, deviceID } = req.body;

  if (!user_id || !role || !deviceID) {
    return res
      .status(400)
      .json({ error: "user_id, role, and deviceID are required" });
  }

  const conn = await pool.getConnection();
  try {
    // 🔎 Step 1: Check if user exists
    const [userRows] = await conn.query(
      `SELECT user_id, role FROM users WHERE user_id = ?`,
      [user_id]
    );

    if (userRows.length === 0) {
      return res
        .status(404)
        .json({ error: "User ID not found in the database" });
    }

    // ✅ Optional: Check if role matches with what's stored
    const storedRole = userRows[0].role;
    if (storedRole !== role) {
      return res.status(400).json({
        error: `Role mismatch. Provided role is '${role}' but found '${storedRole}' in DB`,
      });
    }

    // 🔧 Step 2: Determine the correct table
    let table = "";
    if (role === "driver") {
      table = "driver_devices";
    } else if (role === "user") {
      table = "user_devices";
    } else {
      return res.status(400).json({ error: "Invalid role provided" });
    }

    // 🔄 Step 3: Update or Insert device ID
    const [existingRows] = await conn.query(
      `SELECT id FROM ${table} WHERE user_id = ?`,
      [user_id]
    );

    if (existingRows.length > 0) {
      await conn.query(
        `UPDATE ${table} SET device_id = ?, updated_at = NOW() WHERE user_id = ?`,
        [deviceID, user_id]
      );
    } else {
      await conn.query(
        `INSERT INTO ${table} (user_id, device_id, updated_at) VALUES (?, ?, NOW())`,
        [user_id, deviceID]
      );
    }

    return res
      .status(200)
      .json({ message: "✅ Device ID updated successfully" });
  } catch (err) {
    console.error("❌ Error updating device ID:", err);
    return res.status(500).json({ error: "Failed to update device ID" });
  } finally {
    conn.release();
  }
};

module.exports = { updateDeviceID };
