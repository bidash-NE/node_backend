// controllers/businessTypesController.js
const {
  getAllBusinessTypes,
  getBusinessTypeById,
  getBusinessTypesByType,
  addBusinessType,
  updateBusinessType,
  deleteBusinessType,
} = require("../models/businessTypesModel");

// Extract acting admin for logs
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function actor(req) {
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

// GET /api/business-types
exports.listBusinessTypes = async (req, res) => {
  try {
    const out = await getAllBusinessTypes();
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("listBusinessTypes error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Unable to fetch business types." });
  }
};

// GET /api/business-types/:id
exports.getBusinessType = async (req, res) => {
  try {
    const out = await getBusinessTypeById(req.params.id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("getBusinessType error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Unable to fetch business type." });
  }
};

// GET /api/business-types/type/food
exports.listFoodBusinessTypes = async (_req, res) => {
  try {
    const out = await getBusinessTypesByType("food");
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("listFoodBusinessTypes error:", e);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch food business types.",
    });
  }
};

// GET /api/business-types/type/mart
exports.listMartBusinessTypes = async (_req, res) => {
  try {
    const out = await getBusinessTypesByType("mart");
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("listMartBusinessTypes error:", e);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch mart business types.",
    });
  }
};

// POST /api/business-types
exports.createBusinessType = async (req, res) => {
  try {
    const { user_id, admin_name } = actor(req);
    const { name, description, types } = req.body || {};
    const out = await addBusinessType(
      name,
      description,
      types,
      user_id,
      admin_name
    );
    return res.status(out.success ? 201 : 400).json(out);
  } catch (e) {
    console.error("createBusinessType error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Unable to add business type." });
  }
};

// PUT /api/business-types/:id
exports.updateBusinessType = async (req, res) => {
  try {
    const { user_id, admin_name } = actor(req);
    const { name, description, types } = req.body || {};
    const out = await updateBusinessType(
      req.params.id,
      name,
      description,
      types,
      user_id,
      admin_name
    );
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("updateBusinessType error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Unable to update business type." });
  }
};

// DELETE /api/business-types/:id
exports.removeBusinessType = async (req, res) => {
  try {
    const { user_id, admin_name } = actor(req);
    const out = await deleteBusinessType(req.params.id, user_id, admin_name);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    if (
      e &&
      (e.code === "ER_ROW_IS_REFERENCED" || e.code === "ER_ROW_IS_REFERENCED_2")
    ) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete: business type is in use.",
      });
    }
    console.error("removeBusinessType error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Unable to delete business type." });
  }
};
