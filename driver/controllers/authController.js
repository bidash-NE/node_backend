// controllers/authController.js ✅ (returns proper success/error always)
const redis = require("../models/redisClient");
const { transporter, from, isConfigured } = require("../config/mailer");
const db = require("../config/db");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

exports.sendOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    if (!emailRaw) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address" });
    }

    if (!isConfigured || !transporter || !from) {
      return res.status(500).json({
        success: false,
        message: "SMTP not configured. Check SMTP_HOST/SMTP_USER/SMTP_PASS",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // block if already registered
    const [rows] = await db.execute(
      "SELECT user_id FROM users WHERE email = ?",
      [cleanEmail]
    );
    if (rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Email already registered. OTP not sent.",
      });
    }

    // store OTP 5 min
    await redis.set(`otp:${cleanEmail}`, otp, { ex: 300 });

    const info = await transporter.sendMail({
      from,
      to: cleanEmail,
      subject: "Registration OTP",
      text: `Your OTP is: ${otp}. It will expire in 5 minutes.`,
      html: `<p>Your OTP is:</p><h2>${otp}</h2><p>Expires in 5 minutes.</p>`,
      // keep simple — envelope not needed here
    });

    if (!info?.accepted || info.accepted.length === 0) {
      return res.status(500).json({
        success: false,
        message: "SMTP did not accept recipient",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
      error: err?.message || String(err),
    });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const otpRaw = req.body?.otp;

    if (!emailRaw || !otpRaw) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address" });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = String(otpRaw).trim();

    const storedOtp = await redis.get(`otp:${cleanEmail}`);

    if (!storedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired",
      });
    }

    if (String(storedOtp).trim() !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await redis.set(`verified:${cleanEmail}`, "true", { ex: 900 }); // 15 mins
    await redis.del(`otp:${cleanEmail}`);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "OTP verification failed",
      error: err?.message || String(err),
    });
  }
};
