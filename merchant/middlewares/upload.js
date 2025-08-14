// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Map field names to their folders
const DIRS = {
  license_image: "uploads/licenses",
  business_logo: "uploads/logos",
  bank_card_front_image: "uploads/bank_cards",
  bank_card_back_image: "uploads/bank_cards",
  bank_qr_code_image: "uploads/bank_qr",
  default: "uploads/misc",
};

// Make sure all directories exist at startup
Object.values(DIRS).forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = DIRS[file.fieldname] || DIRS.default;
    // Ensure dir exists before saving
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = [".jpg", ".jpeg", ".png", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowed.includes(ext)) {
    return cb(new Error("Only images are allowed (jpg, jpeg, png, webp)"));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
});

module.exports = upload;
