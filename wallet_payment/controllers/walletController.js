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
  const prefix = walletId.slice(0, 3); // NET
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
  }); // e.g. 10 Nov 2025

  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }); // e.g. 09:51:10 AM

  return { dateStr, timeStr };
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

// NEW: Check whether a wallet for given user_id has a T-PIN set
// NEW: Check whether a wallet for given user_id has a T-PIN set
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

    const wallet = await getWallet({ key: wallet_id });
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });
    }

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

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;

    await redis.set(redisKey, otp, { EX: 600 });

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

/* ---------- USER / MERCHANT / DRIVER WALLET TRANSFER ---------- */
/**
 * Body:
 * {
 *   "sender_wallet_id": "NET000123",
 *   "recipient_wallet_id": "NET000456",
 *   "amount": 225,
 *   "note": "Tt",
 *   "t_pin": "1234"
 * }
 */
async function userTransfer(req, res) {
  try {
    const {
      sender_wallet_id,
      recipient_wallet_id,
      amount,
      note = "",
      t_pin,
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

    const pinStr = String(t_pin || "").trim();
    if (!/^\d{4}$/.test(pinStr)) {
      return res.status(400).json({
        success: false,
        message: "t_pin must be a 4-digit numeric code.",
      });
    }

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

    const { dateStr, timeStr } = formatReceiptDateTime(); // use current time

    const receipt = {
      amount: `Nu. ${Number(amount).toFixed(2)}`,
      journal_no: journal_code,
      transaction_id: primaryTxnId, // ✅ only first ID shown
      from_account: maskWallet(sender_wallet_id),
      to_account: maskWallet(recipient_wallet_id),
      purpose: note || "N/A",
      date: dateStr,
      time: timeStr,
    };

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
  userTransfer,
  checkTPinByUserId, // <-- exported new function
};
