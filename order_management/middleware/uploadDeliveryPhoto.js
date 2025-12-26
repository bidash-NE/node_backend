// middleware/uploadDeliveryPhoto.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "order_delivery_photos";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

const MAX_PHOTOS = 6;

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

/**
 * ✅ Accept up to 6 images.
 * Supports any of these field names from frontend:
 * - delivery_photo (single or multiple)
 * - delivery_photos (multiple)
 * - image (single or multiple)
 * - images (multiple)
 */
function uploadDeliveryPhotos() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB per image
      files: MAX_PHOTOS, // ✅ hard limit at multer level
    },
  }).fields([
    { name: "delivery_photo", maxCount: MAX_PHOTOS },
    { name: "delivery_photos", maxCount: MAX_PHOTOS },
    { name: "image", maxCount: MAX_PHOTOS },
    { name: "images", maxCount: MAX_PHOTOS },
  ]);

  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) {
        console.error("[uploadDeliveryPhotos] multer error:", err);
        err.statusCode = 400;
        return next(err);
      }

      const any = req.files || {};

      // flatten all accepted fields to one list
      const list = []
        .concat(any.delivery_photo || [])
        .concat(any.delivery_photos || [])
        .concat(any.image || [])
        .concat(any.images || []);

      if (list.length > MAX_PHOTOS) {
        console.error("[uploadDeliveryPhotos] Too many files:", list.length);
        return res.status(400).json({
          success: false,
          message: `You can upload up to ${MAX_PHOTOS} photos only.`,
        });
      }

      // ✅ normalized array
      req.deliveryPhotos = list;

      console.log(
        "[uploadDeliveryPhotos] uploaded count:",
        req.deliveryPhotos.length,
        req.deliveryPhotos.map((f) => f.filename)
      );

      next();
    });
  };
}

function toWebPath(fileObj) {
  if (!fileObj?.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

function toWebPaths(filesArr) {
  const arr = Array.isArray(filesArr) ? filesArr : [];
  return arr.map(toWebPath).filter(Boolean).slice(0, MAX_PHOTOS);
}

module.exports = {
  uploadDeliveryPhotos: uploadDeliveryPhotos(),
  toWebPath,
  toWebPaths,
  MAX_PHOTOS,
  SUBFOLDER,
  DEST,
  UPLOAD_ROOT,
};
