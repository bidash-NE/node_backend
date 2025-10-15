// middleware/uploadBusinessTypeImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const SUBFOLDER = "business-types";
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
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };
  return map[mimetype] || ".jpg";
}

function slugBase(v = "bt") {
  return (
    (String(v) || "bt")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "bt"
  );
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    ensureDirSync(DEST);
    cb(null, DEST);
  },
  filename: function (req, file, cb) {
    const ext = safeExt(file.originalname, file.mimetype);
    const base = slugBase(req.body?.name || "bt");
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

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

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadBusinessTypeImage: upload.single("image"),
  toWebPath,
  SUBFOLDER,
  DEST,
};
