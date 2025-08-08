const db = require("../config/db"); // MySQL pool
const redisClient = require("../models/redisClient");
const Driver = require("../models/driverModel");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

// Send OTP to email
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  try {
    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ error: "Email not found." });

    const otp = Math.floor(100000 + Math.random() * 900000);
    await redisClient.set(`otp:${email}`, otp.toString(), { ex: 300 });

    // Send OTP via nodemailer
    const transporter = nodemailer.createTransport({
      service: "Gmail", // or use your SMTP settings
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false, // 👈 Accept self-signed certs
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Reset Your Password OTP ",
      html: `<p>Your OTP is <b>${otp}</b>. It will expire in 5 minutes.</p>`,
    });

    res.json({ message: "OTP sent to email." });
  } catch (err) {
    console.error("Send OTP Error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Verify OTP
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required" });
  }

  try {
    const redisKey = `otp:${email.trim().toLowerCase()}`;
    const storedOtp = await redisClient.get(redisKey);

    console.log("Stored OTP:", storedOtp, "| Type:", typeof storedOtp);
    console.log("Entered OTP:", otp, "| Type:", typeof otp);

    if (!storedOtp) {
      return res.status(400).json({ error: "OTP expired or not found" });
    }

    if (storedOtp.toString().trim() !== otp.toString().trim()) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await redisClient.del(redisKey); // Clean up after successful verification

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("OTP Verification Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Reset Password
exports.resetPassword = async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res
      .status(400)
      .json({ error: "Email and new password are required." });
  }

  try {
    // Check user in MySQL
    const [userRows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userRows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update MySQL
    await db.query("UPDATE users SET password_hash = ? WHERE email = ?", [
      hashedPassword,
      email,
    ]);

    // If driver, also update in MongoDB
    if (user.role === "driver") {
      await Driver.updateOne(
        { user_id: user.user_id },
        { $set: { password: hashedPassword } }
      );
    }

    return res.status(200).json({ message: "Password reset successfully." });
  } catch (err) {
    console.error("Reset Password Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
