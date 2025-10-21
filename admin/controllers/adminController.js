// controllers/adminController.js
const adminModel = require("../models/adminModel");

// helpers to extract acting admin for logs
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function getActor(req) {
  return {
    user_id:
      toIntOrNull(req.user?.user_id) ??
      toIntOrNull(req.headers["x-admin-id"]) ??
      toIntOrNull(req.body?.user_id) ??
      null,
    admin_name:
      req.user?.admin_name ??
      req.headers["x-admin-name"] ??
      req.body?.admin_name ??
      null,
  };
}

// Users (role='user')
exports.getAllNormalUsers = async (_req, res) => {
  try {
    const users = await adminModel.fetchUsersByRole();
    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Drivers (with license + vehicles)
exports.getAllDrivers = async (_req, res) => {
  try {
    const drivers = await adminModel.fetchDrivers();
    res.status(200).json({
      success: true,
      count: drivers.length,
      data: drivers,
    });
  } catch (error) {
    console.error("Error fetching drivers:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Admins list
exports.getAllAdmins = async (_req, res) => {
  try {
    const admins = await adminModel.fetchAdmins();
    res.status(200).json({
      success: true,
      count: admins.length,
      data: admins,
    });
  } catch (error) {
    console.error("Error fetching admins:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Merchants + business details + profile image (business_logo)
exports.getAllMerchantsWithDetails = async (_req, res) => {
  try {
    const merchants = await adminModel.fetchMerchantsWithBusiness();
    return res.status(200).json({
      success: true,
      count: merchants.length,
      data: merchants,
    });
  } catch (error) {
    console.error("Error fetching merchants:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

// ===== activate/deactivate/delete =====
exports.deactivateUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.deactivateUser(
      user_id,
      actor.user_id,
      actor.admin_name
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (result.already === "deactivated")
      return res
        .status(200)
        .json({ success: true, message: "Already deactivated" });

    return res.status(200).json({ success: true, message: "User deactivated" });
  } catch (error) {
    console.error("Deactivate error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

exports.activateUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.activateUser(
      user_id,
      actor.user_id,
      actor.admin_name
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (result.already === "active")
      return res.status(200).json({ success: true, message: "Already active" });

    return res.status(200).json({ success: true, message: "User activated" });
  } catch (error) {
    console.error("Activate error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.deleteUser(
      user_id,
      actor.user_id,
      actor.admin_name
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    return res.status(200).json({ success: true, message: "User deleted" });
  } catch (error) {
    if (error && error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({
        success: false,
        error: "Cannot delete user due to linked records.",
      });
    }
    console.error("Delete error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};
