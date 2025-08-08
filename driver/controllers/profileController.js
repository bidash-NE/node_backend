const db = require("../config/db"); // your MySQL config
const fs = require("fs");
const path = require("path");
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
