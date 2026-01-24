// middlewares/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Define upload root (K8s: /uploads | local: ./uploads)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// 🧩 Map field names → subfolders
const SUBFOLDERS = {
  license_image: "licenses",
  business_logo: "logos",

  bank_qr_code_image: "bank_qr",
  default: "misc",
};

// 🧱 Ensure a directory exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 🧰 Create all known upload subfolders at startup (kept same)
Object.values(SUBFOLDERS).forEach((sub) => {
  ensureDirSync(path.join(UPLOAD_ROOT, sub));
});

// ⚙️ Multer Storage Configuration
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

// 🧤 File filter (extensions)
const fileFilter = (_req, file, cb) => {
  const allowedExt = [".jpg", ".jpeg", ".png", ".webp"];
  const ext = (path.extname(file.originalname || "") || "").toLowerCase();

  const allowedMime = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedExt.includes(ext) || !allowedMime.includes(file.mimetype)) {
    return cb(
      new Error("Only image files are allowed (jpg, jpeg, png, webp)."),
    );
  }
  cb(null, true);
};

// 🚀 Initialize Multer instance
// 🚀 Initialize Multer instance
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // ✅ 15MB per file (adjust)
    files: 2, // ✅ allow business_logo + license_image together
  },
});

// 🌍 Utility to generate public web paths
function toWebPath(fieldname, filename) {
  const sub = SUBFOLDERS[fieldname] || SUBFOLDERS.default;
  return `/uploads/${sub}/${filename}`;
}

/* =========================
   EXPORTS (important part)
   =========================
   Export the Multer instance directly so router code:
     const upload = require("../middlewares/upload");
     upload.single("business_logo")
   works without changes.
*/
upload.toWebPath = toWebPath; // optional: accessible as upload.toWebPath
upload.UPLOAD_ROOT = UPLOAD_ROOT; // optional: accessible as upload.UPLOAD_ROOT
upload.SUBFOLDERS = SUBFOLDERS; // optional

module.exports = upload;
