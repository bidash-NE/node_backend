// middlewares/uploadMartMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const SUBFOLDER = "mart-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(DEST);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    let ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if (!ext || ext.length > 6) ext = ".jpg";

    const base =
      (req.body?.item_name || "item")
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60) || "item";

    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    cb(null, `${unique}-${base}${ext}`);
  },
});

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
  cb(new Error("Only image files are allowed"));
};

// ✅ Simplest approach - accept ANY fields (both files and text)
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 15 },
});

function uploadMartMenuImage(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error("Multer error:", err);
      err.statusCode = 400;
      return next(err);
    }

    const files = req.files || [];

    // Find main image
    req.file = files.find(
      (f) =>
        f.fieldname === "item_image" ||
        f.fieldname === "image" ||
        f.fieldname === "file",
    );

    // Find additional images
    req.additionalFiles = files.filter(
      (f) => f.fieldname === "additional_images",
    );

    // Find product_images files if any (treat them as additional images)
    const productImageFiles = files.filter(
      (f) => f.fieldname === "product_images",
    );
    req.additionalFiles = [...req.additionalFiles, ...productImageFiles];

    // Store all file paths for processing
    req.allUploadedFiles = files;

    return next();
  });
}

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

function toWebPaths(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  return fileObjs.map((file) => `/uploads/${SUBFOLDER}/${file.filename}`);
}

module.exports = {
  uploadMartMenuImage,
  toWebPath,
  toWebPaths,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
};
