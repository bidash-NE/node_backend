const multer = require("multer");
const path = require("path");
const fs = require("fs");

// 📁 Define folder path
const uploadDir = path.join(__dirname, "../uploads/profiles");

// 📂 Ensure folder exists or create it
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`📁 Created folder: ${uploadDir}`);
}

// 💾 Storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `profile_${Date.now()}${ext}`;
    cb(null, uniqueName);
  },
});

// 🛡️ File filter
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed!"));
  }
};

const upload = multer({
  storage,
  fileFilter,
});

module.exports = upload;
