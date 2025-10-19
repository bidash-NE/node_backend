// controllers/walletController.js
const {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
} = require("../models/walletModel");
const { toThimphuString } = require("../utils/time");

function mapLocalTimes(row) {
  if (!row) return row;
  return {
    ...row,
    created_at: toThimphuString(row.created_at),
    updated_at: toThimphuString(row.updated_at),
  };
}

// ---------------- POST /wallet/create ----------------
exports.create = async (req, res) => {
  try {
    const { user_id, status = "ACTIVE" } = req.body || {};

    if (!user_id || !Number.isInteger(user_id) || user_id <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id must be a valid positive integer.",
      });
    }

    const st = String(status).toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st)) {
      return res.status(400).json({
        success: false,
        message: "status must be either ACTIVE or INACTIVE.",
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
      message: "Wallet created successfully.",
      data: mapLocalTimes(result),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ---------------- GET /wallet/getall ----------------
exports.getAll = async (req, res) => {
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
};

// ---------------- GET /wallet/getone/:wallet_id ----------------
exports.getByIdParam = async (req, res) => {
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
};

// ---------------- ✅ GET /wallet/getbyuser/:user_id ----------------
exports.getByUserId = async (req, res) => {
  try {
    const { user_id } = req.params;
    if (!user_id || isNaN(user_id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id." });
    }
    const wallet = await getWalletByUserId(user_id);
    if (!wallet)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found for this user." });
    res.json({ success: true, data: mapLocalTimes(wallet) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ---------------- PUT /wallet/:wallet_id/:status ----------------
exports.updateStatusByParam = async (req, res) => {
  try {
    const { wallet_id, status } = req.params;
    const st = String(status).toUpperCase();

    if (!["ACTIVE", "INACTIVE"].includes(st)) {
      return res.status(400).json({
        success: false,
        message: "status must be either ACTIVE or INACTIVE.",
      });
    }

    const updated = await updateWalletStatus({ key: wallet_id, status: st });
    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });

    res.json({
      success: true,
      message: "Wallet status updated successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ---------------- DELETE /wallet/delete/:wallet_id ----------------
exports.removeByParam = async (req, res) => {
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

    res.json({ success: true, message: "Wallet deleted successfully." });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
