// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Use env if provided (e.g., UPLOAD_ROOT=/uploads from Kubernetes), else fallback
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(__dirname, "../uploads");
const uploadDir = path.join(UPLOAD_ROOT, "profiles");

// 📂 Ensure folder exists or create it
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`📁 Created folder: ${uploadDir}`);
}

// 💾 Storage configuration
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `profile_${Date.now()}${ext}`;
    cb(null, uniqueName);
  },
});

// 🛡️ File filter — only images allowed
const fileFilter = (_req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed!"));
  }
};

// 🚀 Multer upload instance
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

module.exports = upload;
