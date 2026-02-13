// controllers/walletController.js
const {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
  setWalletTPin,
} = require("../models/walletModel");

const { adminTipTransfer } = require("../models/adminTransferModel");
const { userWalletTransfer } = require("../models/userTransferModel");
const { toThimphuString } = require("../utils/time");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const redis = require("../utils/redisClient");
const { sendOtpEmail } = require("../utils/mailer");

/* ---------------- SMS ENV ---------------- */
const SMS_API_URL = process.env.SMS_API_URL && process.env.SMS_API_URL.trim();
const SMS_API_KEY = (process.env.SMS_API_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "Taabdoe").trim();

/* ---------------- EXPO PUSH ENV ---------------- */
const EXPO_NOTIFICATION_URL = (process.env.EXPO_NOTIFICATION_URL || "").trim();

/* ---------- helpers ---------- */

function mapLocalTimes(row) {
  if (!row) return row;
  return {
    ...row,
    created_at: toThimphuString(row.created_at),
    updated_at: toThimphuString(row.updated_at),
  };
}

// NET000069 -> NET*****69
function maskWallet(walletId) {
  if (!walletId || walletId.length < 5) return walletId;
  const prefix = walletId.slice(0, 3);
  const last2 = walletId.slice(-2);
  const maskedMid = "*".repeat(walletId.length - prefix.length - 2);
  return prefix + maskedMid + last2;
}

// 2025-11-10 / 09:51:10 AM style
function formatReceiptDateTime(date) {
  const d = date ? new Date(date) : new Date();

  const dateStr = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  return { dateStr, timeStr };
}

function normalizeBhutanPhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return null;

  const digits = raw.replace(/[^\d]/g, "");

  // 8-digit local -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // already 975xxxxxxxx
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  return digits || null;
}

async function sendOtpSms({
  to,
  otp,
  purposeTitle = "Verification code",
  ttlMinutes = 5,
}) {
  if (!SMS_API_KEY) throw new Error("SMS_API_KEY missing in env");

  // ✅ Your requested format: title + message + advice (OTP only ONCE)
  const text =
    `${purposeTitle}\n\n` +
    `${otp}\n\n` +
    `This code is valid for ${ttlMinutes} minutes.\n` +
    `Do not share this code with anyone.`;

  const resp = await fetch(SMS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SMS_API_KEY,
    },
    body: JSON.stringify({ to, text, from: SMS_FROM }),
  });

  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
  }

  // may be JSON or string
  try {
    return JSON.parse(bodyText);
  } catch {
    return { ok: true, response: bodyText };
  }
}

/* ==========================
   ✅ EXPO PUSH (NEW)
   Payload required by your Expo service:
   { user_id, title, body }
========================== */
async function sendExpoNotification({ user_id, title, body }) {
  if (!EXPO_NOTIFICATION_URL)
    return {
      ok: false,
      skipped: true,
      reason: "EXPO_NOTIFICATION_URL missing",
    };

  const uid = Number(user_id);
  if (!Number.isFinite(uid) || uid <= 0)
    return { ok: false, skipped: true, reason: "Invalid user_id" };

  const payload = {
    user_id: uid,
    title: String(title || "").trim() || "Notification",
    body: String(body || "").trim() || "",
  };

  try {
    const resp = await fetch(EXPO_NOTIFICATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: text };
    }

    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------- CREATE ---------- */
async function create(req, res) {
  try {
    const { user_id, status = "ACTIVE" } = req.body || {};
    if (!user_id || !Number.isInteger(user_id) || user_id <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id." });
    }
    const st = String(status).toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st)) {
      return res.status(400).json({
        success: false,
        message: "Status must be ACTIVE or INACTIVE.",
      });
    }

    const result = await createWallet({ user_id, status: st });
    if (result?.error === "USER_NOT_FOUND")
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    if (result?.error === "WALLET_EXISTS")
      return res.status(409).json({
        success: false,
        message: "Wallet already exists for this user.",
        existing: mapLocalTimes(result.wallet),
      });

    return res.json({
      success: true,
      message: "Wallet created.",
      data: mapLocalTimes(result),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- READ ALL ---------- */
async function getAll(req, res) {
  try {
    const { limit = 50, offset = 0, status = null } = req.query || {};
    const rows = await listWallets({ limit, offset, status });
    res.json({
      success: true,
      count: rows.length,
      data: rows.map(mapLocalTimes),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- READ ONE (by wallet_id) ---------- */
async function getByIdParam(req, res) {
  try {
    const { wallet_id } = req.params;
    const wallet = await getWallet({ key: wallet_id });
    if (!wallet)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    res.json({ success: true, data: mapLocalTimes(wallet) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- READ ONE (by user_id) ---------- */
async function getByUserId(req, res) {
  try {
    const { user_id } = req.params;
    if (!user_id || isNaN(user_id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id." });

    const wallet = await getWalletByUserId(user_id);
    if (!wallet)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found for this user." });
    res.json({ success: true, data: mapLocalTimes(wallet) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- HAS T-PIN (by user_id) ---------- */
async function checkTPinByUserId(req, res) {
  try {
    const { user_id } = req.params;

    if (!user_id || isNaN(user_id) || Number(user_id) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id.",
      });
    }

    const wallet = await getWalletByUserId(Number(user_id));
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found for this user.",
      });
    }

    const hasTPin = !!wallet.t_pin && wallet.t_pin !== "";

    return res.json({
      success: true,
      user_id: Number(user_id),
      has_tpin: hasTPin,
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- UPDATE STATUS ---------- */
async function updateStatusByParam(req, res) {
  try {
    const { wallet_id, status } = req.params;
    const st = String(status).toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st))
      return res
        .status(400)
        .json({ success: false, message: "Invalid status." });

    const updated = await updateWalletStatus({ key: wallet_id, status: st });
    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });

    res.json({
      success: true,
      message: "Wallet status updated.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- DELETE ---------- */
async function removeByParam(req, res) {
  try {
    const { wallet_id } = req.params;
    const out = await deleteWallet({ key: wallet_id });

    if (!out.ok && out.code === "NOT_FOUND")
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    if (!out.ok && out.code === "HAS_TRANSACTIONS")
      return res.status(409).json({
        success: false,
        message: "Cannot delete wallet with transactions.",
      });

    res.json({ success: true, message: "Wallet deleted." });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- ADMIN TIP TRANSFER ---------- */
async function adminTipTransferHandler(req, res) {
  try {
    const {
      admin_name,
      admin_wallet_id,
      user_wallet_id,
      amount,
      note = "",
    } = req.body || {};

    if (!admin_name || admin_name.trim().length < 2)
      return res
        .status(400)
        .json({ success: false, message: "admin_name is required." });
    if (!admin_wallet_id || !/^NET/i.test(admin_wallet_id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid admin_wallet_id." });
    if (!user_wallet_id || !/^NET/i.test(user_wallet_id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_wallet_id." });
    if (admin_wallet_id === user_wallet_id)
      return res
        .status(400)
        .json({ success: false, message: "Wallets must differ." });
    if (isNaN(amount) || Number(amount) <= 0)
      return res
        .status(400)
        .json({ success: false, message: "amount must be positive (Nu)." });

    const result = await adminTipTransfer({
      admin_name: admin_name.trim(),
      admin_wallet_id,
      user_wallet_id,
      amount_nu: Number(amount),
      note,
    });

    if (!result.ok)
      return res
        .status(result.status || 400)
        .json({ success: false, message: result.message });

    res.json({
      success: true,
      message: "Tip transferred successfully.",
      data: result,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- SET / CREATE T-PIN ---------- */
async function setTPin(req, res) {
  try {
    const { wallet_id } = req.params;
    const { t_pin } = req.body || {};

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const pinStr = String(t_pin || "").trim();
    if (!/^\d{4}$/.test(pinStr)) {
      return res.status(400).json({
        success: false,
        message: "t_pin must be a 4-digit numeric code (e.g. 1234).",
      });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    if (wallet.t_pin && wallet.t_pin !== "") {
      return res.status(409).json({
        success: false,
        message: "T-PIN already set. Use change endpoint to modify it.",
      });
    }

    const hashedPin = await bcrypt.hash(pinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashedPin,
    });

    if (!updated) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to set T-PIN." });
    }

    return res.json({
      success: true,
      message: "T-PIN set successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error setting T-PIN:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- CHANGE T-PIN ---------- */
async function changeTPin(req, res) {
  try {
    const { wallet_id } = req.params;
    const { old_t_pin, new_t_pin } = req.body || {};

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const oldPinStr = String(old_t_pin || "").trim();
    if (!/^\d{4}$/.test(oldPinStr)) {
      return res.status(400).json({
        success: false,
        message: "old_t_pin must be a 4-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();
    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    if (oldPinStr === newPinStr) {
      return res.status(400).json({
        success: false,
        message: "New T-PIN must be different from the old T-PIN.",
      });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    if (!wallet.t_pin) {
      return res.status(409).json({
        success: false,
        message: "T-PIN not set yet. Please set it first.",
      });
    }

    const isMatch = await bcrypt.compare(oldPinStr, wallet.t_pin);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Old T-PIN is incorrect.",
      });
    }

    const newHashed = await bcrypt.hash(newPinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: newHashed,
    });

    if (!updated) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to update T-PIN." });
    }

    return res.json({
      success: true,
      message: "T-PIN changed successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error changing T-PIN:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- FORGOT T-PIN: REQUEST OTP (EMAIL) ---------- */
async function forgotTPinRequest(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    const [rows] = await db.query(
      "SELECT user_id, email, user_name FROM users WHERE user_id = ? LIMIT 1",
      [wallet.user_id],
    );

    if (!rows.length || !rows[0].email) {
      return res.status(404).json({
        success: false,
        message: "User email not found.",
      });
    }

    const user = rows[0];
    const email = String(user.email || "")
      .trim()
      .toLowerCase();
    const userName = user.user_name || null;

    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isValidEmail) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address for this user.",
      });
    }

    const rlKey = `tpin_reset_email_rl:${wallet.user_id}:${wallet.wallet_id}`;
    if (await redis.get(rlKey)) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP.",
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;

    await redis.set(redisKey, otp, "EX", 300);
    await redis.set(rlKey, "1", "EX", 30);

    await sendOtpEmail({
      to: email,
      otp,
      userName,
      walletId: wallet.wallet_id,
    });

    return res.json({
      success: true,
      message:
        "OTP has been sent to your registered email address. It is valid for 5 minutes.",
    });
  } catch (e) {
    console.error("Error in forgotTPinRequest:", e);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP.",
      error: e?.message || String(e),
    });
  }
}

/* ---------- FORGOT T-PIN: VERIFY OTP (EMAIL) & SET NEW T-PIN ---------- */
async function forgotTPinVerify(req, res) {
  try {
    const { wallet_id } = req.params;
    const { otp, new_t_pin } = req.body || {};

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const otpStr = String(otp || "").trim();
    if (!/^\d{6}$/.test(otpStr)) {
      return res.status(400).json({
        success: false,
        message: "otp must be a 6-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();
    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;
    const savedOtp = await redis.get(redisKey);

    if (!savedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired or not found. Please request a new OTP.",
      });
    }

    if (savedOtp !== otpStr) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    const hashed = await bcrypt.hash(newPinStr, 10);
    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashed,
    });

    await redis.del(redisKey);

    if (!updated) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to update T-PIN." });
    }

    return res.json({
      success: true,
      message: "T-PIN reset successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error in forgotTPinVerify:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* =========================================================
   ✅ NEW: FORGOT T-PIN (SMS): REQUEST OTP
   POST /wallet/:wallet_id/forgot-tpin-sms
========================================================= */
async function forgotTPinRequestSms(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    const [rows] = await db.query(
      "SELECT user_id, phone, user_name FROM users WHERE user_id = ? LIMIT 1",
      [wallet.user_id],
    );

    if (!rows.length || !rows[0].phone) {
      return res.status(404).json({
        success: false,
        message: "User phone not found.",
      });
    }

    const user = rows[0];
    const phoneToSend = normalizeBhutanPhone(user.phone);

    if (!phoneToSend) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number format.",
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const redisKey = `tpin_reset_sms:${wallet.user_id}:${wallet.wallet_id}`;

    await redis.set(redisKey, otp, "EX", 300);

    await sendOtpSms({
      to: phoneToSend,
      otp,
      purposeTitle: "T-PIN reset code",
      ttlMinutes: 5,
    });

    return res.json({
      success: true,
      message:
        "OTP has been sent to your registered phone number. It is valid for 10 minutes.",
    });
  } catch (e) {
    console.error("Error in forgotTPinRequestSms:", e);
    return res.status(500).json({ success: false, message: e.message });
  }
}

/* =========================================================
   ✅ NEW: FORGOT T-PIN (SMS): VERIFY OTP & SET NEW T-PIN
   POST /wallet/:wallet_id/forgot-tpin-sms/verify
   body: { otp, new_t_pin }
========================================================= */
async function forgotTPinVerifySms(req, res) {
  try {
    const { wallet_id } = req.params;
    const { otp, new_t_pin } = req.body || {};

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const otpStr = String(otp || "").trim();
    if (!/^\d{6}$/.test(otpStr)) {
      return res.status(400).json({
        success: false,
        message: "otp must be a 6-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();
    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    const redisKey = `tpin_reset_sms:${wallet.user_id}:${wallet.wallet_id}`;
    const savedOtp = await redis.get(redisKey);

    if (!savedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired or not found. Please request a new OTP.",
      });
    }

    if (String(savedOtp).trim() !== otpStr) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    const hashed = await bcrypt.hash(newPinStr, 10);
    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashed,
    });

    await redis.del(redisKey);

    if (!updated) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to update T-PIN." });
    }

    return res.json({
      success: true,
      message: "T-PIN reset successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error in forgotTPinVerifySms:", e);
    return res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- USER WALLET TRANSFER ---------- */
async function userTransfer(req, res) {
  try {
    const {
      sender_wallet_id,
      recipient_wallet_id,
      amount,
      note = "",
      t_pin,
      biometric = false,
    } = req.body || {};

    if (!sender_wallet_id || !/^NET/i.test(sender_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sender_wallet_id.",
      });
    }

    if (!recipient_wallet_id || !/^NET/i.test(recipient_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid recipient_wallet_id.",
      });
    }

    if (sender_wallet_id === recipient_wallet_id) {
      return res.status(400).json({
        success: false,
        message: "Sender and recipient wallet must be different.",
      });
    }

    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a positive number (Nu).",
      });
    }

    const biometricOk =
      biometric === true || biometric === "true" || biometric === 1;

    // load sender wallet
    const senderWallet = await getWallet({ key: sender_wallet_id });
    if (!senderWallet) {
      return res.status(404).json({
        success: false,
        message: "Sender wallet not found.",
      });
    }

    if (senderWallet.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Sender wallet is not ACTIVE.",
      });
    }

    // verify pin if not biometric
    if (!biometricOk) {
      const pinStr = String(t_pin || "").trim();
      if (!/^\d{4}$/.test(pinStr)) {
        return res.status(400).json({
          success: false,
          message: "t_pin must be a 4-digit numeric code.",
        });
      }

      if (!senderWallet.t_pin) {
        return res.status(409).json({
          success: false,
          message: "T-PIN not set for this wallet.",
        });
      }

      const okPin = await bcrypt.compare(pinStr, senderWallet.t_pin);
      if (!okPin) {
        return res.status(401).json({
          success: false,
          message: "Invalid T-PIN.",
        });
      }
    }

    // load recipient wallet
    const recipientWallet = await getWallet({ key: recipient_wallet_id });
    if (!recipientWallet) {
      return res.status(404).json({
        success: false,
        message: "Recipient wallet not found.",
      });
    }

    if (recipientWallet.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Recipient wallet is not ACTIVE.",
      });
    }

    // perform transfer (db transaction happens in model)
    const result = await userWalletTransfer({
      sender_wallet_id,
      recipient_wallet_id,
      amount_nu: Number(amount),
      note,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message || "Transfer failed.",
      });
    }

    const { journal_code, transaction_ids } = result;
    const primaryTxnId = Array.isArray(transaction_ids)
      ? transaction_ids[0]
      : null;

    const { dateStr, timeStr } = formatReceiptDateTime();

    const receipt = {
      amount: `Nu. ${Number(amount).toFixed(2)}`,
      journal_no: journal_code,
      transaction_id: primaryTxnId,
      from_account: maskWallet(sender_wallet_id),
      to_account: maskWallet(recipient_wallet_id),
      purpose: note || "N/A",
      date: dateStr,
      time: timeStr,
      biometric: biometricOk,
    };

    // ✅ NEW: send Expo push to BOTH sender and receiver
    // Sender = debited, Receiver = credited
    const amtStr = `Nu. ${Number(amount).toFixed(2)}`;
    const jrn = journal_code || "N/A";
    const tnx = primaryTxnId || "N/A";

    const senderTitle = "Wallet Transfer - Debited";
    const senderBody =
      `Amount: ${amtStr} (DEBITED)\n` +
      `Journal No: ${jrn}\n` +
      `Txn ID: ${tnx}\n` +
      `To: ${maskWallet(recipient_wallet_id)}` +
      (note ? `\nNote: ${note}` : "");

    const receiverTitle = "Wallet Transfer - Credited";
    const receiverBody =
      `Amount: ${amtStr} (CREDITED)\n` +
      `Journal No: ${jrn}\n` +
      `Txn ID: ${tnx}\n` +
      `From: ${maskWallet(sender_wallet_id)}` +
      (note ? `\nNote: ${note}` : "");

    // fire-and-forget (do not fail transfer if notification fails)
    Promise.allSettled([
      sendExpoNotification({
        user_id: senderWallet.user_id,
        title: senderTitle,
        body: senderBody,
      }),
      sendExpoNotification({
        user_id: recipientWallet.user_id,
        title: receiverTitle,
        body: receiverBody,
      }),
    ]).then((r) => {
      const s = r?.[0]?.status === "fulfilled" ? r[0].value : r?.[0]?.reason;
      const rr = r?.[1]?.status === "fulfilled" ? r[1].value : r?.[1]?.reason;
      console.log("[EXPO] sender:", s);
      console.log("[EXPO] receiver:", rr);
    });

    return res.json({
      success: true,
      message: "Wallet transfer successful.",
      receipt,
    });
  } catch (e) {
    console.error("Error in userTransfer:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- GET USER_NAME BY WALLET_ID ---------- */
async function getUserNameByWalletId(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    const [rows] = await db.query(
      "SELECT user_id, user_name FROM users WHERE user_id = ?",
      [wallet.user_id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found for this wallet.",
      });
    }

    const user = rows[0];

    return res.json({
      success: true,
      data: {
        user_id: user.user_id,
        user_name: user.user_name,
      },
    });
  } catch (e) {
    console.error("Error in getUserNameByWalletId:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

module.exports = {
  create,
  getAll,
  getByIdParam,
  getByUserId,
  updateStatusByParam,
  removeByParam,
  adminTipTransfer: adminTipTransferHandler,
  setTPin,
  changeTPin,
  forgotTPinRequest,
  forgotTPinVerify,
  forgotTPinRequestSms,
  forgotTPinVerifySms,
  userTransfer,
  checkTPinByUserId,
  getUserNameByWalletId,
};
