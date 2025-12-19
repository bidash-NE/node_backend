// middleware/uploadDeliveryPhoto.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Use env if provided (e.g., UPLOAD_ROOT=/uploads from Kubernetes), else fallback
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(__dirname, "../uploads");

// 📂 Store delivery photos here
const uploadDir = path.join(UPLOAD_ROOT, "order_delivery_photos");

// Ensure folder exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`📁 Created folder: ${uploadDir}`);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `delivery_${Date.now()}_${Math.round(
      Math.random() * 1e9
    )}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req, file, cb) => {
  if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
  else cb(new Error("Only image files are allowed!"));
};

const uploadDeliveryPhoto = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = { uploadDeliveryPhoto, UPLOAD_ROOT };
