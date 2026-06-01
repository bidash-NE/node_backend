// middlewares/imageCompression.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const TARGET_KB_DEFAULT = 100;

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/svg",
  "application/octet-stream",
]);

const allowedExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
]);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isLikelyImage(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  return allowedMimeTypes.has(mimetype) || allowedExtensions.has(ext);
}

function collectUploadedFiles(req) {
  const files = [];

  if (req.file) files.push(req.file);

  if (Array.isArray(req.files)) {
    files.push(...req.files);
  }

  if (req.files && typeof req.files === "object" && !Array.isArray(req.files)) {
    Object.values(req.files).forEach((value) => {
      if (Array.isArray(value)) files.push(...value);
    });
  }

  return files;
}

async function compressImageToTargetKB(inputPath, options = {}) {
  const {
    targetKB = TARGET_KB_DEFAULT,
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

        console.log("[IMAGE COMPRESSED]", {
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

  console.log("[IMAGE COMPRESSED - ABOVE TARGET]", {
    file: inputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

async function compressFilesFromRequest(req, options = {}) {
  const files = collectUploadedFiles(req);

  if (!files.length) return [];

  req.compressed_files = [];

  for (const file of files) {
    if (!file?.path) continue;

    if (!isLikelyImage(file)) {
      try {
        fs.unlinkSync(file.path);
      } catch {}

      throw new Error(
        `Only image files are allowed. Received field=${file.fieldname}, originalname=${file.originalname}, mimetype=${file.mimetype}`,
      );
    }

    const compression = await compressImageToTargetKB(file.path, {
      targetKB: 100,
      ...options,
    });

    const stat = fs.statSync(file.path);

    file.size = stat.size;
    file.compression = compression;

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

  return req.compressed_files;
}

function wrapMulterWithCompression(multerMiddleware, options = {}) {
  return (req, res, next) => {
    multerMiddleware(req, res, async (err) => {
      if (err) return next(err);

      try {
        await compressFilesFromRequest(req, {
          targetKB: 100,
          ...options,
        });

        return next();
      } catch (compressionErr) {
        return next(compressionErr);
      }
    });
  };
}

module.exports = {
  ensureDirSync,
  isLikelyImage,
  compressImageToTargetKB,
  compressFilesFromRequest,
  wrapMulterWithCompression,
};