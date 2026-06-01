// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

/* ---------------- folders ---------------- */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const profileDir = path.join(UPLOAD_ROOT, "profiles");
const documentDir = path.join(UPLOAD_ROOT, "documents");

makeDir(UPLOAD_ROOT);
makeDir(profileDir);
makeDir(documentDir);

/* ---------------- helpers ---------------- */

const allowedImageMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/octet-stream", // fallback for some clients
]);

const allowedImageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
]);

function isLikelyImage(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  return allowedImageMimeTypes.has(mimetype) || allowedImageExtensions.has(ext);
}

const fileFilter = (_req, file, cb) => {
  console.log("[DRIVER UPLOAD FILE]", {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  if (isLikelyImage(file)) return cb(null, true);

  return cb(
    new Error(
      `Only image files are allowed. Received mimetype=${file.mimetype}, file=${file.originalname}`,
    ),
    false,
  );
};

async function compressImageToTargetKB(inputPath, options = {}) {
  const {
    targetKB = 100,
    startQuality = 80,
    minQuality = 35,
    startWidth = 900,
    startHeight = 900,
    minWidth = 300,
    minHeight = 300,
  } = options;

  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error("Image file not found for compression.");
  }

  const targetBytes = targetKB * 1024;

  let width = startWidth;
  let height = startHeight;
  let quality = startQuality;
  let finalBuffer = null;
  let finalMeta = null;

  while (width >= minWidth && height >= minHeight) {
    quality = startQuality;

    while (quality >= minQuality) {
      const buffer = await sharp(inputPath)
        .rotate()
        .resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({
          quality,
          effort: 6,
        })
        .toBuffer();

      finalBuffer = buffer;
      finalMeta = {
        width,
        height,
        quality,
        sizeKB: Number((buffer.length / 1024).toFixed(2)),
      };

      if (buffer.length <= targetBytes) {
        fs.writeFileSync(inputPath, buffer);

        console.log("[DRIVER IMAGE COMPRESSED]", {
          file: inputPath,
          targetKB,
          ...finalMeta,
        });

        return finalMeta;
      }

      quality -= 5;
    }

    width = Math.floor(width * 0.85);
    height = Math.floor(height * 0.85);
  }

  if (!finalBuffer) {
    throw new Error("Image compression failed.");
  }

  fs.writeFileSync(inputPath, finalBuffer);

  console.log("[DRIVER IMAGE COMPRESSED - ABOVE TARGET]", {
    file: inputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/**
 * Multer runs before compression.
 * This middleware compresses whatever multer has saved.
 */
function compressUploadedImages(options = {}) {
  const compressionOptions = {
    targetKB: 100,
    startQuality: 80,
    minQuality: 35,
    startWidth: 900,
    startHeight: 900,
    minWidth: 300,
    minHeight: 300,
    ...options,
  };

  return async (req, res, next) => {
    try {
      const files = [];

      if (req.file) {
        files.push(req.file);
      }

      if (Array.isArray(req.files)) {
        files.push(...req.files);
      }

      if (req.files && typeof req.files === "object" && !Array.isArray(req.files)) {
        Object.values(req.files).forEach((value) => {
          if (Array.isArray(value)) files.push(...value);
        });
      }

      if (!files.length) return next();

      req.compressed_files = [];

      for (const file of files) {
        const compression = await compressImageToTargetKB(
          file.path,
          compressionOptions,
        );

        req.compressed_files.push({
          fieldname: file.fieldname,
          originalname: file.originalname,
          filename: file.filename,
          path: file.path,
          sizeKB: compression.sizeKB,
          quality: compression.quality,
          width: compression.width,
          height: compression.height,
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/* ---------------- profile upload ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileDir),

    filename: (_req, _file, cb) => {
      const fileName = `profile_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ---------------- document upload ---------------- */

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, documentDir),

    filename: (_req, _file, cb) => {
      const fileName = `doc_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ---------------- exports: keep old functionality ---------------- */

module.exports = upload;
module.exports.documentUpload = documentUpload;
module.exports.compressUploadedImages = compressUploadedImages;
module.exports.compressImageToTargetKB = compressImageToTargetKB;
module.exports.UPLOAD_ROOT = UPLOAD_ROOT;