// controllers/authController.js
const redis = require("../models/redisClient");
const { transporter, from, isConfigured } = require("../config/mailer");
const db = require("../config/db");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

// ✅ Registration (Email) - TabDhey format
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

    // Block if already registered (registration OTP)
    const [rows] = await db.execute(
      "SELECT user_id, user_name FROM users WHERE email = ? LIMIT 1",
      [cleanEmail]
    );

    if (rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Email already registered. OTP not sent.",
      });
    }

    await redis.set(`otp:${cleanEmail}`, otp, { ex: 300 });

    const userName = "Valued User";
    const disclaimer =
      "Disclaimer: Please do NOT share this OTP or your password with anyone. " +
      "TabDhey will never ask for your OTP, password, or T-PIN. " +
      "If you did not request this OTP, please ignore this email.";

    const subject = "Your OTP for Registration";

    const text =
      `Dear ${userName},\n\n` +
      `Welcome to TabDhey!\n\n` +
      `Your OTP is:\n\n` +
      `${otp}\n\n` +
      `This OTP is valid for 5 minutes and can only be used once.\n\n` +
      `${disclaimer}\n\n` +
      `Everything at your door step!\n` +
      `TabDhey`;

    const html =
      `<p>Dear ${userName},</p>` +
      `<p>Welcome to <b>TabDhey</b>!</p>` +
      `<p>Your OTP is:</p>` +
      `<h2 style="letter-spacing:4px;">${otp}</h2>` +
      `<p>This OTP is valid for <b>5 minutes</b> and can only be used once.</p>` +
      `<hr />` +
      `<p style="font-size:12px;color:#777;">${disclaimer}</p>` +
      `<p><b>Everything at your door step!</b><br/>TabDhey</p>`;

    const info = await transporter.sendMail({
      from,
      to: cleanEmail,
      subject,
      text,
      html,
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
