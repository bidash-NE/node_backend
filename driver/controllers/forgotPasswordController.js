const db = require("../config/db"); // MySQL pool
const redisClient = require("../models/redisClient");
const Driver = require("../models/driverModel");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

/* ---------------- fetch (Node 18+ has global fetch) ---------------- */
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

/* ---------------- SMS gateway config ---------------- */
const SMS_URL =
  process.env.SMS_URL || "https://grab.newedge.bt/sms/api/sms/send";
const SMS_MASTER_KEY = (process.env.SMS_MASTER_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "Taabdoe").trim();

/* ---------------- helpers ---------------- */

// keep lookup "not normalized": we generate candidates, but we only normalize AFTER user exists
function buildLookupCandidates(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];

  const digits = raw.replace(/[^\d]/g, "");
  const candidates = new Set();

  // as-is raw (maybe DB stores like "975...." or "17....")
  candidates.add(raw);

  // digits-only version
  if (digits) candidates.add(digits);

  // if user typed 8 digits, also try adding 975 for lookup
  if (digits.length === 8) candidates.add(`975${digits}`);

  return Array.from(candidates).filter(Boolean);
}

function normalizeForGateway(phoneFromDbOrMatch) {
  const raw = String(phoneFromDbOrMatch || "").trim();
  const digits = raw.replace(/[^\d]/g, "");

  // 8 digits -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // 975xxxxxxxx (11 digits)
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  return null;
}

function makeOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSmsGateway({ to, text, from }) {
  if (!SMS_MASTER_KEY) throw new Error("SMS_MASTER_KEY missing in .env");

  const resp = await fetchFn(SMS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SMS_MASTER_KEY, // ✅ required
    },
    body: JSON.stringify({ to, text, from }),
  });

  const bodyText = await resp.text();
  if (!resp.ok)
    throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
  return bodyText;
}

/**
 * Find user by phone WITHOUT normalizing input first.
 * We check DB using candidates from raw input.
 * If user found, we then normalize the stored phone for sending.
 */
async function findUserByPhoneNoNormalize(inputPhone) {
  const candidates = buildLookupCandidates(inputPhone);
  if (!candidates.length) return { user: null, gatewayPhone: null };

  const placeholders = candidates.map(() => "?").join(",");

  // ✅ Only phone column (your schema has just phone)
  const sql = `
    SELECT user_id, role, phone
    FROM users
    WHERE phone IN (${placeholders})
    LIMIT 1
  `;

  const [rows] = await db.execute(sql, candidates);

  const user = rows?.[0] || null;
  if (!user) return { user: null, gatewayPhone: null };

  // Normalize only AFTER user exists (prefer DB stored phone)
  const stored = user.phone || "";
  const gatewayPhone =
    normalizeForGateway(stored) || normalizeForGateway(candidates[0]);

  return { user, gatewayPhone };
}

/* ============================================================
   ✅ 1) SEND OTP SMS (Forgot password)
   Body: { phone }
   - OTP valid: 5 minutes
   ============================================================ */
exports.sendOtpSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(inputPhone);
    if (!user)
      return res.status(404).json({ error: "Phone number not found." });

    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    // resend cooldown 30s
    const rlKey = `fp_sms_rl:${gatewayPhone}`;
    if (await redisClient.get(rlKey)) {
      return res
        .status(429)
        .json({ error: "Please wait before requesting another OTP." });
    }

    const otp = makeOtp();

    // store OTP 5 mins
    const otpKey = `fp_sms_otp:${gatewayPhone}`;
    await redisClient.set(otpKey, otp, { ex: 300 });
    await redisClient.set(rlKey, "1", { ex: 30 });

    const text =
      `Password reset code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    await sendSmsGateway({
      to: gatewayPhone,
      text,
      from: SMS_FROM,
    });

    return res.status(200).json({
      message: "OTP sent via SMS.",
    });
  } catch (err) {
    console.error("Send OTP SMS Error:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/* ============================================================
   ✅ 2) VERIFY OTP SMS
   Body: { phone, otp }
   - sets verified flag for 15 mins
   ============================================================ */
exports.verifyOtpSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;
    const otp = String(req.body.otp || "").trim();

    if (!inputPhone || !otp) {
      return res.status(400).json({ error: "Phone and OTP are required" });
    }

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(inputPhone);
    if (!user)
      return res.status(404).json({ error: "Phone number not found." });
    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    const otpKey = `fp_sms_otp:${gatewayPhone}`;
    const storedOtp = await redisClient.get(otpKey);

    if (!storedOtp)
      return res.status(410).json({ error: "OTP expired or not found" });
    if (String(storedOtp).trim() !== otp)
      return res.status(401).json({ error: "Invalid OTP" });

    const verifiedKey = `fp_sms_verified:${gatewayPhone}`;
    await redisClient.set(verifiedKey, "true", { ex: 900 }); // 15 mins
    await redisClient.del(otpKey);

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("Verify OTP SMS Error:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/* ============================================================
   ✅ 3) RESET PASSWORD BY PHONE (NEW)
   POST /reset-password-sms
   Body: { phone, newPassword }
   - requires verifyOtpSms first (verified flag)
   ============================================================ */
exports.resetPasswordSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;
    const newPassword = String(req.body.newPassword || "");

    if (!inputPhone || !newPassword) {
      return res.status(400).json({
        error: "Phone and newPassword are required.",
      });
    }

    if (newPassword.trim().length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(inputPhone);
    if (!user)
      return res.status(404).json({ error: "Phone number not found." });

    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    // must be verified
    const verifiedKey = `fp_sms_verified:${gatewayPhone}`;
    const verified = await redisClient.get(verifiedKey);

    if (!verified) {
      return res.status(403).json({
        error: "OTP not verified. Please verify OTP first.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update MySQL (by user_id is safest)
    await db.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [
      hashedPassword,
      user.user_id,
    ]);

    // If driver, also update in MongoDB
    if (String(user.role || "").toLowerCase() === "driver") {
      await Driver.updateOne(
        { user_id: user.user_id },
        { $set: { password: hashedPassword } }
      );
    }

    // cleanup verification flag
    await redisClient.del(verifiedKey);

    return res.status(200).json({ message: "Password reset successfully." });
  } catch (err) {
    console.error("Reset Password SMS Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/* ===========================
   EXISTING EMAIL OTP FLOW
   (UNCHANGED)
=========================== */

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
      service: "Gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false,
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

    if (!storedOtp) {
      return res.status(400).json({ error: "OTP expired or not found" });
    }

    if (storedOtp.toString().trim() !== otp.toString().trim()) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await redisClient.del(redisKey);

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("OTP Verification Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Reset Password (email)
exports.resetPassword = async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res
      .status(400)
      .json({ error: "Email and new password are required." });
  }

  try {
    const [userRows] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = userRows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query("UPDATE users SET password_hash = ? WHERE email = ?", [
      hashedPassword,
      email,
    ]);

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
