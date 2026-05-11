// middlewares/uploadMartMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// Use /uploads in k8s, ./uploads locally
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "mart-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

/* ensure target dir exists */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

/* storage */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    // safe extension
    let ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if (!ext || ext.length > 6) ext = ".jpg";

    // slug from item_name
    const base =
      (req.body?.item_name || "item")
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60) || "item";

    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

/* validation */
const allowedMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/svg",
]);

const fileFilter = (_req, file, cb) => {
  if (allowedMimes.has(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files are allowed (png, jpg, webp, gif, svg)."));
};

/* Updated multer uploader - include ALL possible field names from HTML form */
const fieldsUploader = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 15 }, // Allow up to 15 files total
}).fields([
  { name: "item_image", maxCount: 1 }, // Main image
  { name: "image", maxCount: 1 }, // Alternative main image field
  { name: "file", maxCount: 1 }, // Another alternative
  { name: "additional_images", maxCount: 10 }, // Multiple additional images
  { name: "product_images", maxCount: 1 }, // Optional: comma-separated URLs field
  { name: "business_id", maxCount: 1 }, // Non-file field (ignored by multer)
  { name: "category_name", maxCount: 1 }, // Non-file field
  { name: "item_name", maxCount: 1 }, // Non-file field
  { name: "description", maxCount: 1 }, // Non-file field
  { name: "actual_price", maxCount: 1 }, // Non-file field
  { name: "discount_percentage", maxCount: 1 }, // Non-file field
  { name: "tax_rate", maxCount: 1 }, // Non-file field
  { name: "is_veg", maxCount: 1 }, // Non-file field
  { name: "spice_level", maxCount: 1 }, // Non-file field
  { name: "is_available", maxCount: 1 }, // Non-file field
  { name: "stock_limit", maxCount: 1 }, // Non-file field
  { name: "sort_order", maxCount: 1 }, // Non-file field
  { name: "size_standard", maxCount: 1 }, // Non-file field
  { name: "available_sizes", maxCount: 1 }, // Non-file field
]);

/**
 * Ready-to-use middleware
 */
function uploadMartMenuImage(req, res, next) {
  fieldsUploader(req, res, (err) => {
    if (err) {
      console.error("Multer error:", err);
      err.statusCode = 400;
      return next(err);
    }

    const any = req.files || {};

    // Handle single file (for backward compatibility)
    req.file =
      (Array.isArray(any.item_image) && any.item_image[0]) ||
      (Array.isArray(any.image) && any.image[0]) ||
      (Array.isArray(any.file) && any.file[0]) ||
      null;

    // Handle multiple additional images
    req.additionalFiles =
      (Array.isArray(any.additional_images) && any.additional_images) || [];

    // Also capture product_images field if it's a file
    if (Array.isArray(any.product_images) && any.product_images.length > 0) {
      req.productImagesFiles = any.product_images;
    }

    return next();
  });
}

/* helper used by controllers to build a public path */
function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

/* helper to get multiple file paths */
function toWebPaths(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  return fileObjs.map((file) => `/uploads/${SUBFOLDER}/${file.filename}`);
}

module.exports = {
  uploadMartMenuImage,
  toWebPath,
  toWebPaths,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
};
