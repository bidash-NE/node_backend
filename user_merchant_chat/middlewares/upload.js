// File: middlewares/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

// ✅ Define upload root (K8s: /uploads | local: ./uploads)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// ✅ Only CHAT subfolder
const SUBFOLDERS = {
  chat_image: "chat",
  default: "chat",
};

const TARGET_KB = Number(process.env.CHAT_IMAGE_TARGET_KB || 100);
const MAX_BYTES = Number(process.env.CHAT_IMAGE_MAX_BYTES || 10 * 1024 * 1024);

/* ---------------- directory helpers ---------------- */

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ✅ Ensure chat folder exists at startup
ensureDirSync(path.join(UPLOAD_ROOT, SUBFOLDERS.chat_image));

/* ---------------- helpers ---------------- */

function slugBase(originalName = "chat-image") {
  const ext = path.extname(originalName || "");

  return (
    path
      .basename(originalName || "chat-image", ext)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "chat-image"
  );
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

async function compressImageToTargetKB(inputPath, options = {}) {
  const {
    targetKB = TARGET_KB,
    startQuality = 82,
    minQuality = 35,
    startWidth = 1000,
    startHeight = 1000,
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

        console.log("[CHAT IMAGE COMPRESSED]", {
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

  console.log("[CHAT IMAGE COMPRESSED - ABOVE TARGET]", {
    file: inputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/* ---------------- multer storage ---------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = SUBFOLDERS[file.fieldname] || SUBFOLDERS.default;
    const dest = path.join(UPLOAD_ROOT, sub);

    ensureDirSync(dest);
    cb(null, dest);
  },

  filename: (req, file, cb) => {
    const base = slugBase(file.originalname || "chat-image");
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // ✅ Always save compressed output as .webp
    cb(null, `${unique}-${base}.webp`);
  },
});

const rawUpload = multer({
  storage,

  // Let multer accept first. Sharp validates real image after upload.
  fileFilter: (_req, file, cb) => {
    console.log("[CHAT IMAGE RECEIVED]", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    cb(null, true);
  },

  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
});

/* ---------------- compressed single upload ---------------- */

function single(fieldName) {
  const multerSingle = rawUpload.single(fieldName);

  return function compressedSingleUpload(req, res, next) {
    multerSingle(req, res, async function (err) {
      if (err) {
        console.error("[CHAT IMAGE MULTER ERROR]", {
          code: err.code,
          field: err.field,
          message: err.message,
        });

        return res.status(400).json({
          success: false,
          message: err.message || "Image upload failed.",
          code: err.code,
          field: err.field,
        });
      }

      if (!req.file) {
        return next();
      }

      try {
        // ✅ Sharp validates real image content.
        await sharp(req.file.path).metadata();

        const compression = await compressImageToTargetKB(req.file.path, {
          targetKB: TARGET_KB,
        });

        const stat = fs.statSync(req.file.path);

        req.file.size = stat.size;
        req.file.mimetype = "image/webp";
        req.file.compression = compression;

        return next();
      } catch (compressionErr) {
        console.error("[CHAT IMAGE COMPRESSION ERROR]", {
          originalname: req.file?.originalname,
          mimetype: req.file?.mimetype,
          error: compressionErr.message,
        });

        deleteFileIfExists(req.file?.path);

        return res.status(400).json({
          success: false,
          message:
            "Only valid image files are allowed. If this is an iPhone HEIC image, please convert it to JPG/WebP before uploading.",
          error: compressionErr.message,
        });
      }
    });
  };
}

/* ---------------- public web path ---------------- */

function toWebPath(fieldname, filename) {
  const sub = SUBFOLDERS[fieldname] || SUBFOLDERS.default;
  return `/uploads/${sub}/${filename}`;
}

/* ---------------- export multer-like object ---------------- */

const upload = {
  single,
  toWebPath,
  UPLOAD_ROOT,
  SUBFOLDERS,
  TARGET_KB,
  rawUpload,
};

module.exports = upload;