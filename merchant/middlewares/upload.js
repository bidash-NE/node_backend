// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Root folder (defaults to ./uploads locally, /uploads in k8s)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// 🔧 Ensure directory exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 🗂️ Mapping of fields → subfolders
const SUBFOLDERS = {
  license_image: "licenses",
  business_logo: "logos",
  bank_card_front_image: "bank_cards",
  bank_card_back_image: "bank_cards",
  bank_qr_code_image: "bank_qr",
  // fallback
  default: "misc",
};

// 🏗️ Pre-create all known subfolders at startup
Object.values(SUBFOLDERS).forEach((sub) => {
  const dir = path.join(UPLOAD_ROOT, sub);
  ensureDirSync(dir);
});

// 💾 Storage definition
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = SUBFOLDERS[file.fieldname] || SUBFOLDERS.default;
    const dest = path.join(UPLOAD_ROOT, sub);
    ensureDirSync(dest);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || "") || "").toLowerCase();
    const base = (path.basename(file.originalname, ext) || "file")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60);

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

// 🛡️ File filter
const fileFilter = (_req, file, cb) => {
  const allowedExts = [".jpg", ".jpeg", ".png", ".webp"];
  const ext = (path.extname(file.originalname || "") || "").toLowerCase();
  if (!allowedExts.includes(ext)) {
    return cb(
      new Error("Only image files are allowed (jpg, jpeg, png, webp).")
    );
  }
  cb(null, true);
};

// ⚙️ Multer config
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// 🌐 Utility to build public web path
function toWebPath(fieldname, filename) {
  const sub = SUBFOLDERS[fieldname] || SUBFOLDERS.default;
  return `/uploads/${sub}/${filename}`;
}

module.exports = {
  upload,
  toWebPath,
  UPLOAD_ROOT,
};
