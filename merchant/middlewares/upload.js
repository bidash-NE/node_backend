// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

/* ---------- field → folder mapping ---------- */
const DIRS = {
  license_image: "uploads/licenses",
  business_logo: "uploads/logos",
  bank_card_front_image: "uploads/bank_cards",
  bank_card_back_image: "uploads/bank_cards",
  bank_qr_code_image: "uploads/bank_qr",
  default: "uploads/misc",
};

/* ---------- ensure dirs exist at boot ---------- */
Object.values(DIRS).forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ---------- helpers ---------- */
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
    "image/svg": ".svg",
  };
  return map[mimetype] || ".jpg";
}

function slugBase(v = "image") {
  return (
    (String(v) || "image")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "image"
  );
}

/* ---------- storage ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = DIRS[file.fieldname] || DIRS.default;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = safeExt(file.originalname, file.mimetype);
    const base =
      slugBase(
        req.body?.title ||
          req.body?.name ||
          req.body?.business_name ||
          file.fieldname
      ) || "image";
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

/* ---------- validation ---------- */
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

/* ---------- factory & defaults ---------- */
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

module.exports = upload;
module.exports.DIRS = DIRS;
