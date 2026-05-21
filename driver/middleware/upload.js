// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const profileDir  = path.join(UPLOAD_ROOT, "profiles");
const documentDir = path.join(UPLOAD_ROOT, "documents");
makeDir(profileDir);
makeDir(documentDir);

const fileFilter = (_req, file, cb) => {
  if (file.mimetype.startsWith("image/")) cb(null, true);
  else cb(new Error("Only image files are allowed!"));
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `profile_${Date.now()}${ext}`);
    },
  }),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, documentDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `doc_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = upload;
module.exports.documentUpload = documentUpload;
