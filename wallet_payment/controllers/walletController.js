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
const { toThimphuString } = require("../utils/time");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const redis = require("../utils/redisClient");
const { sendOtpEmail } = require("../utils/mailer");

function mapLocalTimes(row) {
  if (!row) return row;
  return {
    ...row,
    created_at: toThimphuString(row.created_at),
    updated_at: toThimphuString(row.updated_at),
  };
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

/* ---------- CHANGE T-PIN (with old PIN verification) ---------- */
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

/* ---------- FORGOT T-PIN: REQUEST OTP ---------- */
async function forgotTPinRequest(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!wallet_id || typeof wallet_id !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    // Get wallet (to get user_id)
    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

    // Fetch user email from users table
    const [rows] = await db.query(
      "SELECT user_id, email, user_name FROM users WHERE user_id = ?",
      [wallet.user_id]
    );
    if (!rows.length || !rows[0].email) {
      return res.status(404).json({
        success: false,
        message: "User email not found.",
      });
    }

    const user = rows[0];
    const email = user.email;
    const userName = user.user_name || null;

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Store OTP in Redis with TTL (10 minutes)
    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;
    await redis.set(redisKey, otp, { EX: 600 });

    // Send email
    await sendOtpEmail({
      to: email,
      otp,
      userName,
      walletId: wallet.wallet_id,
    });

    return res.json({
      success: true,
      message:
        "OTP has been sent to your registered email address. It is valid for 10 minutes.",
    });
  } catch (e) {
    console.error("Error in forgotTPinRequest:", e);
    res.status(500).json({ success: false, message: e.message });
  }
}

/* ---------- FORGOT T-PIN: VERIFY OTP & SET NEW T-PIN ---------- */
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

    // Get wallet (for user_id)
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

    // OTP is valid → update T-PIN
    const hashed = await bcrypt.hash(newPinStr, 10);
    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashed,
    });

    // Invalidate OTP
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
};
