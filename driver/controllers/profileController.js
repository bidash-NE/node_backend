const { prisma } = require("../lib/prisma.js");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

// Helper function to convert BigInt to Number recursively
function serializeBigInt(data) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "bigint") {
    return Number(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => serializeBigInt(item));
  }

  if (typeof data === "object") {
    const serialized = {};
    for (const key in data) {
      serialized[key] = serializeBigInt(data[key]);
    }
    return serialized;
  }

  return data;
}

// GET profile
exports.getProfile = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);

    // ✅ Using Prisma to get user profile
    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        user_name: true,
        email: true,
        phone: true,
        role: true,
        profile_image: true,
        is_verified: true,
        is_active: true,
        last_login: true,
        points: true, // ⭐ include points here
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // ✅ Convert BigInt values before sending response
    const serializedUser = serializeBigInt(user);
    res.status(200).json(serializedUser);
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// UPDATE profile
exports.updateProfile = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    const { user_name, email, phone } = req.body;
    let newProfileImage = null;

    // 1. Handle new uploaded profile image
    if (req.file) {
      newProfileImage = `/uploads/profiles/${req.file.filename}`;

      // ✅ Using Prisma to get current profile image
      const user = await prisma.users.findUnique({
        where: { user_id: userId },
        select: { profile_image: true },
      });

      if (user && user.profile_image) {
        const oldImagePath = path.join(__dirname, "..", user.profile_image);
        fs.unlink(oldImagePath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("❌ Failed to delete old profile image:", err);
          }
        });
      }
    }

    // 2. Build update data dynamically
    const updateData = {};

    if (user_name) {
      updateData.user_name = user_name;
    }

    if (email) {
      updateData.email = email;
    }

    if (phone) {
      updateData.phone = phone;
    }

    if (newProfileImage) {
      updateData.profile_image = newProfileImage;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields provided to update." });
    }

    // Add updated_at
    updateData.updated_at = new Date();

    // ✅ Using Prisma to update user
    await prisma.users.update({
      where: { user_id: userId },
      data: updateData,
    });

    res.status(200).json({ message: "✅ Profile updated successfully." });
  } catch (err) {
    console.error("⚠️ Profile update error:", err);

    // Handle Prisma specific errors
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }

    res.status(500).json({ error: "Internal server error." });
  }
};

// Change password (assumes bcrypt and db are available)
exports.changePassword = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
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

    // ✅ Using Prisma to fetch user & existing hash
    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { password_hash: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const { password_hash } = user;

    // Verify current password
    const isMatch = await bcrypt.compare(current_password, password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    // Hash and update
    const newHash = await bcrypt.hash(new_password, 10);

    // ✅ Using Prisma to update password
    await prisma.users.update({
      where: { user_id: userId },
      data: { password_hash: newHash },
    });

    return res
      .status(200)
      .json({ message: "✅ Password updated successfully." });
  } catch (err) {
    console.error("Change password error:", err);

    // Handle Prisma specific errors
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }

    return res.status(500).json({
      error: err.sqlMessage || err.message || "Internal server error.",
    });
  }
};
