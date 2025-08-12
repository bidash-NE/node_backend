const db = require("../config/db"); // your MySQL config
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

// GET profile
exports.getProfile = async (req, res) => {
  try {
    const userId = req.params.user_id;
    const [rows] = await db.query(
      `SELECT user_id, user_name, email, phone, role, profile_image, is_verified, is_active, last_login 
       FROM users WHERE user_id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json(rows[0]);
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// UPDATE profile
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.params.user_id;
    const { user_name, phone } = req.body;
    let newProfileImage = null;

    if (req.file) {
      newProfileImage = `/uploads/profiles/${req.file.filename}`;

      // 1. Get old image from DB
      const [userRows] = await db.query(
        "SELECT profile_image FROM users WHERE user_id = ?",
        [userId]
      );

      if (userRows.length > 0 && userRows[0].profile_image) {
        const oldImagePath = path.join(
          __dirname,
          "..",
          userRows[0].profile_image
        );

        // 2. Delete old image if it exists
        fs.unlink(oldImagePath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("❌ Failed to delete old profile image:", err);
          }
        });
      }
    }

    // 3. Construct query and values dynamically
    let query = `UPDATE users SET user_name = ?, phone = ?, `;
    const values = [user_name, phone];

    if (newProfileImage) {
      query += `profile_image = ?, `;
      values.push(newProfileImage);
    }

    query += `updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`;
    values.push(userId);

    // 4. Execute update
    await db.query(query, values);

    res.status(200).json({ message: "✅ Profile updated successfully." });
  } catch (err) {
    console.error("⚠️ Profile update error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Change password (assumes bcrypt and db are available)
exports.changePassword = async (req, res) => {
  try {
    const userId = req.params.user_id;
    const { current_password, new_password } = req.body || {};

    // Basic validations
    if (!current_password || !new_password) {
      return res
        .status(400)
        .json({ error: "current_password and new_password are required." });
    }
    if (new_password.length < 8) {
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters." });
    }
    if (current_password === new_password) {
      return res.status(400).json({
        error: "New password must be different from current password.",
      });
    }

    // Fetch user & existing hash
    const [rows] = await db.query(
      "SELECT password_hash FROM users WHERE user_id = ? LIMIT 1",
      [userId]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const { password_hash } = rows[0];

    // Verify current password
    const isMatch = await bcrypt.compare(current_password, password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    // Hash and update
    const newHash = await bcrypt.hash(new_password, 10);
    await db.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [
      newHash,
      userId,
    ]);

    return res
      .status(200)
      .json({ message: "✅ Password updated successfully." });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({
      error: err.sqlMessage || err.message || "Internal server error.",
    });
  }
};
