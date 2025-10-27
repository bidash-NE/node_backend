// controllers/bannerController.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  createBannerWithWalletCharge,
  getBannerById,
  listBanners,
  listAllBannersForBusiness,
  listActiveByKind,
  updateBanner,
  deleteBanner,
} = require("../models/bannerModel");
const {
  uploadBannerImage,
  toWebPath,
  DEST,
} = require("../middlewares/uploadBannerImage");

const isUploadsPath = (p) =>
  typeof p === "string" && /^\/?uploads\//i.test(String(p).replace(/^\/+/, ""));
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
function saveBase64ImageIfPresent(body) {
  const raw = (body?.banner_image || body?.image || "").toString().trim();
  const m = raw.match(
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i
  );
  if (!m) return null;
  const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const data = m[2];
  const buf = Buffer.from(data, "base64");
  const base =
    (body?.title || "banner")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "banner";
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${base}.${ext}`;
  const abs = path.join(DEST, fileName);
  fs.writeFileSync(abs, buf);
  return `/uploads/banners/${fileName}`;
}
function extractStorableImagePath(req) {
  if (req.file) return toWebPath(req.file);
  const raw = (req.body?.banner_image || req.body?.image || "")
    .toString()
    .trim();
  if (raw.startsWith("/uploads/banners/")) return raw;
  const saved = saveBase64ImageIfPresent(req.body);
  if (saved) return saved;
  return null;
}

// POST /api/banners
async function createBannerCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = extractStorableImagePath(req);

    const user_id = Number(b.user_id);
    const total_amount = Number(b.total_amount);
    if (!Number.isInteger(user_id) || user_id <= 0)
      return res.status(400).json({
        success: false,
        message: "user_id must be a positive integer",
      });
    if (!Number.isFinite(total_amount) || total_amount <= 0)
      return res.status(400).json({
        success: false,
        message: "total_amount must be a positive number",
      });

    const payload = {
      business_id: b.business_id,
      title: b.title,
      description: b.description,
      banner_image: img,
      is_active: b.is_active,
      start_date: b.start_date,
      end_date: b.end_date,
      owner_type: b.owner_type,
    };

    const out = await createBannerWithWalletCharge({
      banner: payload,
      payer_user_id: user_id,
      amount: total_amount,
    });

    if (!out.success) return res.status(400).json(out);

    return res.status(201).json({
      success: true,
      message: "Banner created and payment processed successfully.",
      data: out.data,
      payment: out.payment,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to create banner.",
    });
  }
}

// Other controllers unchanged
async function listBannersCtrl(req, res) {
  try {
    const { business_id, active_only, owner_type } = req.query || {};
    const out = await listBanners({ business_id, active_only, owner_type });
    return res.status(200).json({
      success: true,
      message: "Banners fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch banners.",
    });
  }
}
async function listAllBannersByBusinessCtrl(req, res) {
  try {
    const { owner_type } = req.query || {};
    const out = await listAllBannersForBusiness(
      req.params.business_id,
      owner_type
    );
    return res.status(200).json({
      success: true,
      message: "All banners fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch banners.",
    });
  }
}
async function listActiveFoodCtrl(req, res) {
  try {
    const { business_id } = req.query || {};
    const out = await listActiveByKind("food", business_id);
    return res.status(200).json({
      success: true,
      message: "Active food banners fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch food banners.",
    });
  }
}
async function listActiveMartCtrl(req, res) {
  try {
    const { business_id } = req.query || {};
    const out = await listActiveByKind("mart", business_id);
    return res.status(200).json({
      success: true,
      message: "Active mart banners fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch mart banners.",
    });
  }
}
async function getBannerCtrl(req, res) {
  try {
    const out = await getBannerById(req.params.id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch banner.",
    });
  }
}
async function updateBannerCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const newImg = extractStorableImagePath(req);
    const wantsClear =
      b.banner_image === null ||
      b.banner_image === "null" ||
      b.banner_image === "";
    const fields = {
      ...(b.business_id !== undefined && { business_id: b.business_id }),
      ...(b.title !== undefined && { title: b.title }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.is_active !== undefined && { is_active: b.is_active }),
      ...(b.start_date !== undefined && { start_date: b.start_date }),
      ...(b.end_date !== undefined && { end_date: b.end_date }),
      ...(b.owner_type !== undefined && { owner_type: b.owner_type }),
    };
    if (newImg) fields.banner_image = newImg;
    else if (wantsClear) fields.banner_image = null;

    const out = await updateBanner(id, fields);
    if (!out.success) return res.status(400).json(out);
    return res.status(200).json({
      success: true,
      message: "Banner updated successfully.",
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to update banner.",
    });
  }
}
async function deleteBannerCtrl(req, res) {
  try {
    const out = await deleteBanner(req.params.id);
    if (!out.success) return res.status(404).json(out);
    return res
      .status(200)
      .json({ success: true, message: "Banner deleted successfully." });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to delete banner.",
    });
  }
}

module.exports = {
  uploadBannerImage,
  createBannerCtrl,
  listBannersCtrl,
  listAllBannersByBusinessCtrl,
  listActiveFoodCtrl,
  listActiveMartCtrl,
  getBannerCtrl,
  updateBannerCtrl,
  deleteBannerCtrl,
};
