// merchant/middlewares/uploadBannerImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ✅ Root upload dir: use env (k8s mounts /uploads) or fallback to ./uploads locally
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "banners";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

// Ensure dir exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

// Pick a safe extension if missing/odd
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

// Slugify part of filename
function slugBase(v = "banner") {
  return (
    (String(v) || "banner")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "banner"
  );
}

// Multer storage
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
    const base = slugBase(req.body?.title || "banner");
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

// Allow only images
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

/**
 * Accept either "banner_image" or "image", normalize to req.file
 */
function uploadBannerImage() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).fields([
    { name: "banner_image", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]);

  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) {
        err.statusCode = 400;
        return next(err);
      }
      const any = req.files || {};
      req.file =
        (Array.isArray(any.banner_image) && any.banner_image[0]) ||
        (Array.isArray(any.image) && any.image[0]) ||
        null;
      next();
    });
  };
}

// Build public URL path
function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = { uploadBannerImage, toWebPath, DEST, SUBFOLDER, UPLOAD_ROOT };
