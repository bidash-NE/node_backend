const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const SUBFOLDER = "mart-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

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
    let ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if (!ext || ext.length > 6) ext = ".jpg";
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

function uploadMartMenuImage() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).single("item_image");

  return (req, res, next) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) return next(); // JSON only
    uploader(req, res, (err) => {
      if (err) {
        err.statusCode = 400;
        return next(err);
      }
      next();
    });
  };
}

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = { uploadMartMenuImage, toWebPath, DEST };
