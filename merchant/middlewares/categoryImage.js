// middlewares/uploadCategoryImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function subfolderFor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "food") return "food-category";
  if (k === "mart") return "mart-category";
  return "category";
}

function storageFactory() {
  return multer.diskStorage({
    destination: function (req, file, cb) {
      const kind = req.params.kind || req.query.kind || "category";
      const dest = path.join(UPLOAD_ROOT, subfolderFor(kind));
      ensureDirSync(dest);
      cb(null, dest);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const base =
        (req.body?.category_name || "cat")
          .toString()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "")
          .slice(0, 60) || "cat";
      const unique = `${Date.now()}-${crypto.randomUUID()}`;
      cb(null, `${unique}-${base}${ext || ""}`);
    },
  });
}

const fileFilter = (_req, file, cb) => {
  const allowed = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
  ];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files are allowed (png, jpg, webp, gif, svg)."));
};

/**
 * Accepts either "category_image" or "image".
 * Will expose the picked file at req.file (like .single()).
 */
function uploadCategoryImage() {
  const uploader = multer({
    storage: storageFactory(),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).any(); // accept any field names, we’ll pick allowed ones

  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) return next(err);

      // pick the first allowed file field
      const allowedNames = new Set(["category_image", "image"]);
      const files = Array.isArray(req.files) ? req.files : [];
      const picked = files.find((f) => allowedNames.has(f.fieldname));
      if (picked) {
        req.file = picked; // so your controller keeps working
      } else {
        req.file = null; // no file sent (that’s fine)
      }

      // If a file was sent with a disallowed name (and you want to reject), uncomment:
      // const disallowed = files.find((f) => !allowedNames.has(f.fieldname));
      // if (disallowed) return next(new Error(`Unexpected file field "${disallowed.fieldname}"`));

      next();
    });
  };
}

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
