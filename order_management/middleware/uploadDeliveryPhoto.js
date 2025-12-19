// middleware/uploadDeliveryPhoto.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "order_delivery_photos";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

function safeExt(originalName = "", mimetype = "") {
  const fromName = (path.extname(originalName || "") || "").toLowerCase();
  if (fromName && fromName.length <= 6) return fromName;
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
  };
  return map[mimetype] || ".jpg";
}

const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const ext = safeExt(file.originalname, file.mimetype);
    cb(null, `delivery_${Date.now()}_${crypto.randomUUID()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (allowed.has(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files are allowed (png, jpg, webp)."));
};

// ✅ Accept both field names, normalize to req.file
function uploadDeliveryPhoto() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
  }).fields([
    { name: "delivery_photo", maxCount: 1 },
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
        (Array.isArray(any.delivery_photo) && any.delivery_photo[0]) ||
        (Array.isArray(any.image) && any.image[0]) ||
        null;
      next();
    });
  };
}

function toWebPath(fileObj) {
  if (!fileObj?.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadDeliveryPhoto: uploadDeliveryPhoto(),
  toWebPath,
  SUBFOLDER,
  DEST,
  UPLOAD_ROOT,
};
