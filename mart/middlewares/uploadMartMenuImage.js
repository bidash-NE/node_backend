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

/* underlying multer “fields” uploader, so we can normalize to req.file */
const fieldsUploader = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).fields([
  { name: "item_image", maxCount: 1 },
  { name: "image", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

/**
 * Ready-to-use middleware (NOT a factory). Attach directly in routes.
 * Puts the chosen file on req.file.
 */
function uploadMartMenuImage(req, res, next) {
  fieldsUploader(req, res, (err) => {
    if (err) {
      err.statusCode = 400;
      return next(err);
    }
    const any = req.files || {};
    req.file =
      (Array.isArray(any.item_image) && any.item_image[0]) ||
      (Array.isArray(any.image) && any.image[0]) ||
      (Array.isArray(any.file) && any.file[0]) ||
      null;
    return next();
  });
}

/* helper used by controllers to build a public path */
function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadMartMenuImage, // <- middleware function
  toWebPath, // <- function controllers can call
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
};
