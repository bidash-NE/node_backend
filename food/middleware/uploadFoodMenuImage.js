// middlewares/uploadFoodMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const SUBFOLDER = "food-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    ensureDirSync(DEST);
    cb(null, DEST);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base =
      (req.body?.item_name || "item")
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60) || "item";
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext || ""}`);
  },
});

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

function uploadFoodMenuImage() {
  // Accept either "item_image" or generic "image"
  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).any();

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);
      const allowed = new Set(["item_image", "image"]);
      const files = Array.isArray(req.files) ? req.files : [];
      const picked = files.find((f) => allowed.has(f.fieldname));
      req.file = picked || null;
      next();
    });
  };
}

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = { uploadFoodMenuImage, toWebPath, DEST };
