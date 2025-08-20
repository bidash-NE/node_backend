// controllers/foodMenuController.js
const fs = require("fs");
const path = require("path");

const {
  createFoodMenuItem,
  getFoodMenuItemById,
  listFoodMenuItems,
  listFoodMenuByBusiness,   // NEW
  updateFoodMenuItem,
  deleteFoodMenuItem,
} = require("../models/foodMenuModel");

const { toWebPath } = require("../middleware/uploadFoodMenuImage");

const isUploadsPath = (p) =>
  typeof p === "string" && /^\/?uploads\//i.test(p.replace(/^\/+/, ""));
const toAbsPath = (webPath) =>
  path.join(process.cwd(), webPath.replace(/^\//, ""));

function safeDeleteFile(oldWebPath) {
  if (!oldWebPath) return;
  const normalized = String(oldWebPath).trim();
  if (!isUploadsPath(normalized)) return;
  const abs = toAbsPath(normalized);
  const uploadsRoot = path.join(process.cwd(), "uploads");
  if (!abs.startsWith(uploadsRoot)) return;
  fs.stat(abs, (err, st) => {
    if (err || !st?.isFile()) return;
    fs.unlink(abs, () => {});
  });
}

/* ---------- CREATE ---------- */
async function createFoodMenuCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = req.file ? toWebPath(req.file) : (b.item_image || null);

    const payload = {
      business_id: b.business_id,      // NEW required
      category_name: b.category_name,
      item_name: b.item_name,
      description: b.description,
      item_image: img,
      base_price: b.base_price,
      tax_rate: b.tax_rate,
      is_veg: b.is_veg,
      spice_level: b.spice_level, // 'None'|'Mild'|'Medium'|'Hot'
      is_available: b.is_available,
      stock_limit: b.stock_limit,
      sort_order: b.sort_order,
    };

    const out = await createFoodMenuItem(payload);
    return res
      .status(201)
      .json({ success: true, message: "Food item created successfully.", data: out.data });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to create food item." });
  }
}

/* ---------- LIST (supports filters) ---------- */
async function listFoodMenuCtrl(req, res) {
  try {
    const business_id = req.query.business_id;     // optional
    const category_name = req.query.category_name; // optional
    const out = await listFoodMenuItems({ business_id, category_name });
    return res.status(200).json({
      success: true,
      message: "Food items fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to fetch food items." });
  }
}

/* ---------- GET ALL BY BUSINESS ---------- */
async function listFoodMenuByBusinessCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await listFoodMenuByBusiness(business_id);
    return res.status(200).json({
      success: true,
      message: "Food items for business fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to fetch food items." });
  }
}

/* ---------- GET ONE ---------- */
async function getFoodMenuByIdCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await getFoodMenuItemById(id);
    if (!out.success)
      return res.status(404).json({ success: false, message: out.message });
    return res
      .status(200)
      .json({ success: true, message: "Food item fetched successfully.", data: out.data });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to fetch food item." });
  }
}

/* ---------- UPDATE ---------- */
async function updateFoodMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const newImg = req.file ? toWebPath(req.file) : undefined; // only set if new upload present
    const fields = {
      ...(b.business_id !== undefined && { business_id: b.business_id }),
      ...(b.category_name !== undefined && { category_name: b.category_name }),
      ...(b.item_name !== undefined && { item_name: b.item_name }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.base_price !== undefined && { base_price: b.base_price }),
      ...(b.tax_rate !== undefined && { tax_rate: b.tax_rate }),
      ...(b.is_veg !== undefined && { is_veg: b.is_veg }),
      ...(b.spice_level !== undefined && { spice_level: b.spice_level }),
      ...(b.is_available !== undefined && { is_available: b.is_available }),
      ...(b.stock_limit !== undefined && { stock_limit: b.stock_limit }),
      ...(b.sort_order !== undefined && { sort_order: b.sort_order }),
    };

    if (newImg) fields.item_image = newImg;
    else if (b.item_image === null) fields.item_image = null; // allow clearing image

    const out = await updateFoodMenuItem(id, fields);
    if (!out.success)
      return res.status(400).json({ success: false, message: out.message });

    if (out.old_image && out.new_image && out.old_image !== out.new_image) {
      safeDeleteFile(out.old_image);
    }
    if (fields.item_image === null && out.old_image) {
      safeDeleteFile(out.old_image);
    }

    return res
      .status(200)
      .json({ success: true, message: "Food item updated successfully.", data: out.data });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to update food item." });
  }
}

/* ---------- DELETE ---------- */
async function deleteFoodMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await deleteFoodMenuItem(id);
    if (!out.success)
      return res.status(404).json({ success: false, message: out.message });

    if (out.old_image) safeDeleteFile(out.old_image);

    return res
      .status(200)
      .json({ success: true, message: "Food item deleted successfully." });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to delete food item." });
  }
}

module.exports = {
  createFoodMenuCtrl,
  listFoodMenuCtrl,
  listFoodMenuByBusinessCtrl, // NEW
  getFoodMenuByIdCtrl,
  updateFoodMenuCtrl,
  deleteFoodMenuCtrl,
};
