// controllers/walletController.js
const {
  createWallet,
  getWallet,
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

/* -------------------- POST /wallet (JSON only) -------------------- */
exports.create = async (req, res) => {
  try {
    const { user_id, status = "ACTIVE" } = req.body || {};

    if (
      user_id === undefined ||
      user_id === null ||
      !Number.isInteger(user_id) ||
      user_id <= 0
    ) {
      return res.status(400).json({
        success: false,
        field: "user_id",
        message: "user_id must be a positive integer.",
      });
    }

    const st = String(status).toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st)) {
      return res.status(400).json({
        success: false,
        field: "status",
        message: "status must be either ACTIVE or INACTIVE.",
      });
    }

    const result = await createWallet({ user_id, status: st });

    if (result?.error === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        field: "user_id",
        message: `User with ID ${user_id} does not exist.`,
      });
    }
    if (result?.error === "WALLET_EXISTS") {
      return res.status(409).json({
        success: false,
        field: "user_id",
        message: "Wallet already exists for this user.",
        existing: mapLocalTimes(result.wallet),
      });
    }

    return res.json({
      success: true,
      message: "Wallet created successfully.",
      data: mapLocalTimes(result),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Server error while creating wallet.",
      error: e.message,
    });
  }
};

/* -------------------- GET /wallet (get all) -------------------- */
exports.getAll = async (req, res) => {
  try {
    const { limit = 50, offset = 0, status = null } = req.query || {};
    const rows = await listWallets({ limit, offset, status });
    return res.json({
      success: true,
      count: rows.length,
      data: rows.map(mapLocalTimes),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Unexpected server error.",
      error: e.message,
    });
  }
};

/* -------------------- GET /wallet/:wallet_id -------------------- */
exports.getByIdParam = async (req, res) => {
  try {
    const wallet_id = req.params.wallet_id;
    if (!wallet_id)
      return res
        .status(400)
        .json({ success: false, message: "wallet_id required in URL." });

    const wallet = await getWallet({ key: wallet_id, user_id: null });
    if (!wallet)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });

    return res.json({ success: true, data: mapLocalTimes(wallet) });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Unexpected server error.",
      error: e.message,
    });
  }
};

/* -------------------- PUT /wallet/:wallet_id/:status -------------------- */
exports.updateStatusByParam = async (req, res) => {
  try {
    const { wallet_id, status } = req.params || {};
    if (!wallet_id)
      return res
        .status(400)
        .json({ success: false, message: "wallet_id required in URL." });

    const st = String(status || "").toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st))
      return res.status(400).json({
        success: false,
        field: "status",
        message: "status must be either ACTIVE or INACTIVE.",
      });

    const updated = await updateWalletStatus({ key: wallet_id, status: st });
    if (!updated)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found." });

    return res.json({
      success: true,
      message: "Wallet status updated successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Unexpected server error.",
      error: e.message,
    });
  }
};

/* -------------------- DELETE /wallet/:wallet_id -------------------- */
exports.removeByParam = async (req, res) => {
  try {
    const wallet_id = req.params.wallet_id;
    if (!wallet_id)
      return res
        .status(400)
        .json({ success: false, message: "wallet_id required in URL." });

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

    return res.json({ success: true, message: "Wallet deleted successfully." });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Unexpected server error.",
      error: e.message,
    });
  }
};
