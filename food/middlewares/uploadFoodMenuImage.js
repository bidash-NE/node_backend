const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ✅ Use environment variable or fallback for local
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "food-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

// 🔧 Ensure folder exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

// 🎯 Safe extension mapping
function safeExt(originalName = "", mimetype = "") {
  const fromName = (path.extname(originalName || "") || "").toLowerCase();
  if (fromName && fromName.length <= 6) return fromName;
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };
  return map[mimetype] || ".jpg";
}

// 🏗️ Storage setup
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },
  filename: function (req, file, cb) {
    const ext = safeExt(file.originalname, file.mimetype);
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

// 🧾 File validation
const allowedMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const fileFilter = (_req, file, cb) => {
  if (allowedMimes.has(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files are allowed (png, jpg, webp, gif, svg)."));
};

// 🚀 Main upload middleware
function uploadFoodMenuImage(req, res, next) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("multipart/form-data")) return next(); // skip for JSON requests

  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).fields([
    { name: "item_image", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]);

  uploader(req, res, (err) => {
    if (err) {
      err.statusCode = 400;
      return next(err);
    }

    const any = req.files || {};
    req.file =
      (Array.isArray(any.item_image) && any.item_image[0]) ||
      (Array.isArray(any.image) && any.image[0]) ||
      null;

    // Optional debug
    // console.log("✅ File saved to:", DEST);
    next();
  });
}

// 🌐 Helper to return web-accessible path
function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadFoodMenuImage,
  toWebPath,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
};
