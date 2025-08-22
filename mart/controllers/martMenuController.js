// controllers/martMenuController.js
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
  createMartMenuItem,
  getMartMenuItemById,
  listMartMenuItems,
  listMartMenuByBusiness,
  updateMartMenuItem,
  deleteMartMenuItem,
} = require("../models/martMenuModel");

const { toWebPath } = require("../middlewares/uploadMartMenuImage");

const isLocalUploadsPath = (p) => p && p.startsWith("/uploads/");
const toAbs = (webPath) =>
  path.join(process.cwd(), webPath.replace(/^\/+/, ""));
const safeUnlink = async (abs) => {
  try {
    await fsp.unlink(abs);
    return true;
  } catch {
    return false;
  }
};
const extractIncomingImage = (req) => {
  if (req.file) return toWebPath(req.file);
  const raw = (req.body?.item_image || "").toString().trim();
  if (!raw) return null;
  if (raw.startsWith("/uploads/")) return raw;
  if (raw.startsWith("uploads/")) return `/${raw}`;
  try {
    const u = new URL(raw);
    return u.pathname || raw;
  } catch {
    return raw;
  }
};

// Create
exports.createMartMenu = async (req, res) => {
  try {
    const img = extractIncomingImage(req);
    const payload = {
      business_id: req.body.business_id,
      category_name: req.body.category_name,
      item_name: req.body.item_name,
      description: req.body.description,
      item_image: img,
      base_price: req.body.base_price,
      tax_rate: req.body.tax_rate,
      is_veg: req.body.is_veg,
      spice_level: req.body.spice_level,
      is_available: req.body.is_available,
      stock_limit: req.body.stock_limit,
      sort_order: req.body.sort_order,
    };
    const out = await createMartMenuItem(payload);
    return res.status(201).json(out);
  } catch (e) {
    // cleanup uploaded file if any
    const img = extractIncomingImage(req);
    if (req.file && isLocalUploadsPath(img)) await safeUnlink(toAbs(img));
    return res.status(400).json({
      success: false,
      message: e.message || "Unable to create mart menu",
    });
  }
};

// List with filters ?business_id=&category_name=
exports.listMartMenu = async (req, res) => {
  try {
    const out = await listMartMenuItems({
      business_id: req.query.business_id,
      category_name: req.query.category_name,
    });
    return res.status(200).json(out);
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: "Unable to fetch mart menu" });
  }
};

// List by business
exports.listMartMenuByBusiness = async (req, res) => {
  try {
    const out = await listMartMenuByBusiness(req.params.business_id);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Unable to fetch mart menu by business",
    });
  }
};

// Get one
exports.getMartMenuItem = async (req, res) => {
  try {
    const out = await getMartMenuItemById(req.params.id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: "Unable to fetch mart menu item" });
  }
};

// Update (multipart supported; delete old img if changed)
exports.updateMartMenu = async (req, res) => {
  let current = null;
  try {
    const found = await getMartMenuItemById(req.params.id);
    if (!found.success) return res.status(404).json(found);
    current = found.data;

    const incomingImage = extractIncomingImage(req);
    const fields = {
      business_id: req.body.business_id,
      category_name: req.body.category_name,
      item_name: req.body.item_name,
      description: req.body.description,
      item_image: incomingImage ?? undefined,
      base_price: req.body.base_price,
      tax_rate: req.body.tax_rate,
      is_veg: req.body.is_veg,
      spice_level: req.body.spice_level,
      is_available: req.body.is_available,
      stock_limit: req.body.stock_limit,
      sort_order: req.body.sort_order,
    };

    const out = await updateMartMenuItem(req.params.id, fields);

    // delete old image if replaced and was local
    if (
      incomingImage &&
      incomingImage !== current.item_image &&
      isLocalUploadsPath(current.item_image)
    ) {
      await safeUnlink(toAbs(current.item_image));
    }

    return res.status(out.success ? 200 : 400).json(out);
  } catch (e) {
    // cleanup new uploaded if error
    const incomingImage = extractIncomingImage(req);
    if (req.file && isLocalUploadsPath(incomingImage))
      await safeUnlink(toAbs(incomingImage));
    return res.status(400).json({
      success: false,
      message: e.message || "Unable to update mart menu",
    });
  }
};

// Delete
exports.deleteMartMenu = async (req, res) => {
  try {
    const existing = await getMartMenuItemById(req.params.id);
    if (!existing.success) return res.status(404).json(existing);

    const out = await deleteMartMenuItem(req.params.id);

    if (
      existing.data.item_image &&
      isLocalUploadsPath(existing.data.item_image)
    ) {
      await safeUnlink(toAbs(existing.data.item_image));
    }

    return res.status(200).json(out);
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: "Unable to delete mart menu" });
  }
};
