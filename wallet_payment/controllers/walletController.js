// controllers/walletController.js
const {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
} = require("../models/walletModel");
const { adminTipTransfer } = require("../models/adminTransferModel");
const { toThimphuString } = require("../utils/time");

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
      admin_name: admin_name.trim(), // maps to users.user_name in the model
      admin_wallet_id,
      user_wallet_id,
      amount_nu: Number(amount),
      note,
    });

    if (!result.ok)
      return res
        .status(result.status || 400)
        .json({ success: false, message: result.message });

    return res.json({
      success: true,
      message: "Tip transferred successfully.",
      data: result,
    });
  } catch (e) {
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
};
