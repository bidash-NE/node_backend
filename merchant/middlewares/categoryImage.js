// middlewares/uploadCategoryImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ✅ Root configurable via env (default: ./uploads)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// 🔧 ensure directory exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 🗂️ decide which subfolder to use
function subfolderFor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "food") return "food-category";
  if (k === "mart") return "mart-category";
  return "category";
}

// 🧩 extension safety
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

// 🧱 slugify base name
function slugBase(v = "cat") {
  return (
    (String(v) || "cat")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "cat"
  );
}

// 💾 create storage engine
function storageFactory() {
  return multer.diskStorage({
    destination: function (req, _file, cb) {
      const kind = req.params.kind || req.query.kind || "category";
      const dest = path.join(UPLOAD_ROOT, subfolderFor(kind));
      ensureDirSync(dest);
      cb(null, dest);
    },
    filename: function (req, file, cb) {
      const ext = safeExt(file.originalname, file.mimetype);
      const base = slugBase(req.body?.category_name || "cat");
      const unique = `${Date.now()}-${crypto.randomUUID()}`;
      cb(null, `${unique}-${base}${ext}`);
    },
  });
}

// 🛡️ filter
const fileFilter = (_req, file, cb) => {
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
  ]);
  if (allowed.has(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files are allowed (png, jpg, webp, gif, svg)."));
};

// 🖼️ main middleware
function uploadCategoryImage() {
  const uploader = multer({
    storage: storageFactory(),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).any();

  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) return next(err);
      const allowedNames = new Set(["category_image", "image"]);
      const files = Array.isArray(req.files) ? req.files : [];
      const picked = files.find((f) => allowedNames.has(f.fieldname));
      req.file = picked || null;
      next();
    });
  };
}

// 🌐 build web path
function toWebPathFromFile(req, fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  const sub = subfolderFor(req.params.kind || req.query.kind);
  return `/uploads/${sub}/${fileObj.filename}`;
}

module.exports = {
  uploadCategoryImage,
  toWebPathFromFile,
  ensureDirSync,
  UPLOAD_ROOT,
};
