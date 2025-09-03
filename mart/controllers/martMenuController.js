// controllers/martMenuController.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  createMartMenuItem,
  getMartMenuItemById,
  listMartMenuItems,
  listMartMenuByBusiness,
  updateMartMenuItem,
  deleteMartMenuItem,
} = require("../models/martMenuModel");

const { toWebPath, DEST } = require("../middlewares/uploadMartMenuImage");

// ------------ file helpers ------------
const isUploadsPath = (p) =>
  typeof p === "string" &&
  /^\/?uploads\/mart-menu\//i.test(String(p).replace(/^\/+/, ""));
const toAbsPath = (webPath) =>
  path.join(process.cwd(), String(webPath).replace(/^\//, ""));

function safeDeleteFile(oldWebPath) {
  if (!oldWebPath) return;
  const normalized = String(oldWebPath).trim();
  if (!isUploadsPath(normalized)) return;
  const abs = toAbsPath(normalized);
  const uploadsRoot = path.join(process.cwd(), "uploads");
  const absNorm = path.normalize(abs);
  const rootNorm = path.normalize(uploadsRoot);
  if (!absNorm.startsWith(rootNorm)) return;
  fs.stat(absNorm, (err, st) => {
    if (err || !st?.isFile()) return;
    fs.unlink(absNorm, () => {});
  });
}

// Save base64 data URL to uploads and return web path
function saveBase64ImageIfPresent(body) {
  const raw = (body?.item_image || body?.image || "").toString().trim();
  const m = raw.match(
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i
  );
  if (!m) return null;

  const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const data = m[2];
  const buf = Buffer.from(data, "base64");

  const base =
    (body?.item_name || "item")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "item";

  const fileName = `${Date.now()}-${crypto.randomUUID()}-${base}.${ext}`;
  const abs = path.join(DEST, fileName);
  fs.writeFileSync(abs, buf);
  return `/uploads/mart-menu/${fileName}`;
}

/**
 * Accept ONLY:
 *  1) req.file uploaded by multer -> /uploads/mart-menu/<name>
 *  2) body with already-server-stored path starting with /uploads/mart-menu/
 *  3) base64 data URL in body (data:image/...;base64,...) -> will be saved and return path
 * Everything else (file:///..., http://device/..., etc.) => ignored (null)
 */
function extractStorableImagePath(req) {
  if (req.file) return toWebPath(req.file);

  // Accept already server-stored path
  const raw = (req.body?.item_image || req.body?.image || "").toString().trim();
  if (raw.startsWith("/uploads/mart-menu/")) return raw;

  // Accept base64 data URL
  const saved = saveBase64ImageIfPresent(req.body);
  if (saved) return saved;

  // Reject device-local URIs like file:///...
  return null;
}

// ------------- CREATE -------------
async function createMartMenuCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = extractStorableImagePath(req);

    const payload = {
      business_id: b.business_id, // required
      category_name: b.category_name,
      item_name: b.item_name,
      description: b.description,
      item_image: img,
      actual_price: b.actual_price,
      discount_percentage: b.discount_percentage,
      tax_rate: b.tax_rate,
      is_veg: b.is_veg,
      spice_level: b.spice_level,
      is_available: b.is_available,
      stock_limit: b.stock_limit,
      sort_order: b.sort_order,
    };

    const out = await createMartMenuItem(payload);
    return res.status(201).json({
      success: true,
      message: "Mart item created successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to create mart item.",
    });
  }
}

// ------------- LIST (filters) -------------
async function listMartMenuCtrl(req, res) {
  try {
    const business_id = req.query.business_id;
    const category_name = req.query.category_name;
    const out = await listMartMenuItems({ business_id, category_name });
    return res.status(200).json({
      success: true,
      message: "Mart items fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch mart items.",
    });
  }
}

// ------------- BY BUSINESS -------------
async function listMartMenuByBusinessCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await listMartMenuByBusiness(business_id);
    return res.status(200).json({
      success: true,
      message: "Mart items for business fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch mart items.",
    });
  }
}

// ------------- GET ONE -------------
async function getMartMenuByIdCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await getMartMenuItemById(id);
    if (!out.success)
      return res.status(404).json({ success: false, message: out.message });
    return res.status(200).json({
      success: true,
      message: "Mart item fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch mart item.",
    });
  }
}

// ------------- UPDATE -------------
async function updateMartMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    const newImg = extractStorableImagePath(req);
    const wantsClear =
      b.item_image === null || b.item_image === "null" || b.item_image === "";

    const fields = {
      ...(b.business_id !== undefined && { business_id: b.business_id }),
      ...(b.category_name !== undefined && { category_name: b.category_name }),
      ...(b.item_name !== undefined && { item_name: b.item_name }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.actual_price !== undefined && { actual_price: b.actual_price }),
      ...(b.discount_percentage !== undefined && {
        discount_percentage: b.discount_percentage,
      }),
      ...(b.tax_rate !== undefined && { tax_rate: b.tax_rate }),
      ...(b.is_veg !== undefined && { is_veg: b.is_veg }),
      ...(b.spice_level !== undefined && { spice_level: b.spice_level }),
      ...(b.is_available !== undefined && { is_available: b.is_available }),
      ...(b.stock_limit !== undefined && { stock_limit: b.stock_limit }),
      ...(b.sort_order !== undefined && { sort_order: b.sort_order }),
    };

    if (newImg) fields.item_image = newImg;
    else if (wantsClear) fields.item_image = null;

    const out = await updateMartMenuItem(id, fields);
    if (!out.success)
      return res.status(400).json({ success: false, message: out.message });

    // If image changed (or cleared), remove old file
    if (out.old_image && out.new_image && out.old_image !== out.new_image) {
      safeDeleteFile(out.old_image);
    }
    if (fields.item_image === null && out.old_image) {
      safeDeleteFile(out.old_image);
    }

    return res.status(200).json({
      success: true,
      message: "Mart item updated successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to update mart item.",
    });
  }
}

// ------------- DELETE -------------
async function deleteMartMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await deleteMartMenuItem(id);
    if (!out.success)
      return res.status(404).json({ success: false, message: out.message });

    if (out.old_image) safeDeleteFile(out.old_image);

    return res
      .status(200)
      .json({ success: true, message: "Mart item deleted successfully." });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to delete mart item.",
    });
  }
}

module.exports = {
  createMartMenuCtrl,
  listMartMenuCtrl,
  listMartMenuByBusinessCtrl,
  getMartMenuByIdCtrl,
  updateMartMenuCtrl,
  deleteMartMenuCtrl,
};
