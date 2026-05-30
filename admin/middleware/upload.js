const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Saves inside admin/uploads
// If this file is admin/middleware/upload.js,
// this becomes admin/uploads
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.resolve(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log("✅ Created folder:", dir);
  }
};

const logoImageDir = path.join(UPLOAD_ROOT, "logo_and_image");

makeDir(UPLOAD_ROOT);
makeDir(logoImageDir);

console.log("📁 Admin upload root:", UPLOAD_ROOT);
console.log("📁 Logo/Image upload folder:", logoImageDir);

const imageFileFilter = (_req, file, cb) => {
  if (file.mimetype && file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed!"), false);
  }
};

const logoImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      makeDir(UPLOAD_ROOT);
      makeDir(logoImageDir);
      cb(null, logoImageDir);
    },

    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();

      const fileName = `logo_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}${ext}`;

      cb(null, fileName);
    },
  }),

  fileFilter: imageFileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

module.exports = {
  logoImageUpload,
  UPLOAD_ROOT,
};