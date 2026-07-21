// File: middlewares/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

// ✅ Define upload root
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// ✅ Only CHAT subfolder
const SUBFOLDERS = {
  chat_image: "chat",
  chat_voice: "chat_voice",
  default: "chat",
};

const TARGET_KB = Number(process.env.CHAT_IMAGE_TARGET_KB || 100);
const MAX_BYTES = Number(process.env.CHAT_IMAGE_MAX_BYTES || 10 * 1024 * 1024);
const VOICE_MAX_BYTES = Number(
  process.env.CHAT_VOICE_MAX_BYTES || 10 * 1024 * 1024,
);

const ALLOWED_VOICE_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
]);

// Some containers do not reveal whether their tracks are audio- or video-only.
const ALLOWED_VOICE_CONTAINER_MIME_TYPES = new Set([
  ...ALLOWED_VOICE_MIME_TYPES,
  "application/ogg",
  "video/mp4",
  "video/webm",
]);

/* ---------------- helpers ---------------- */

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirSync(path.join(UPLOAD_ROOT, SUBFOLDERS.chat_image));
ensureDirSync(path.join(UPLOAD_ROOT, SUBFOLDERS.chat_voice));

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

function isHeicFile(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();

  return (
    mime === "image/heic" ||
    mime === "image/heif" ||
    ext === ".heic" ||
    ext === ".heif"
  );
}

async function getInputBufferForSharp(file) {
  const inputBuffer = fs.readFileSync(file.path);

  if (!isHeicFile(file)) {
    return inputBuffer;
  }

  console.log("[CHAT HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  const jpegBuffer = await heicConvert({
    buffer: inputBuffer,
    format: "JPEG",
    quality: 0.9,
  });

  return Buffer.from(jpegBuffer);
}

async function compressImageBufferToTargetKB(inputBuffer, outputPath, options = {}) {
  const {
    targetKB = TARGET_KB,
    startQuality = 82,
    minQuality = 35,
    startWidth = 1000,
    startHeight = 1000,
    minWidth = 300,
    minHeight = 300,
  } = options;

  const targetBytes = targetKB * 1024;

  let width = startWidth;
  let height = startHeight;
  let quality = startQuality;
  let finalBuffer = null;
  let finalMeta = null;

  while (width >= minWidth && height >= minHeight) {
    quality = startQuality;

    while (quality >= minQuality) {
      const buffer = await sharp(inputBuffer)
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
        fs.writeFileSync(outputPath, buffer);

        console.log("[CHAT IMAGE COMPRESSED]", {
          file: outputPath,
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

  fs.writeFileSync(outputPath, finalBuffer);

  console.log("[CHAT IMAGE COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
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
    const base = slugBase(file.originalname || file.fieldname);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (file.fieldname === "chat_voice") {
      const ext = path.extname(file.originalname || "").toLowerCase();
      return cb(null, `${unique}-${base}${ext}`);
    }

    // Save original upload temporarily.
    // Final compressed image will be renamed to .webp after processing.
    cb(null, `${unique}-${base}.upload`);
  },
});

async function validateVoiceFile(file) {
  const { fileTypeFromFile } = await import("file-type");
  const detected = await fileTypeFromFile(file.path);
  const declaredMime = String(file.mimetype || "").toLowerCase();
  const detectedMime = String(detected?.mime || "").toLowerCase();

  if (
    !ALLOWED_VOICE_MIME_TYPES.has(declaredMime) ||
    !ALLOWED_VOICE_CONTAINER_MIME_TYPES.has(detectedMime)
  ) {
    throw new Error("Only valid audio files are allowed for chat_voice.");
  }

  return detected;
}

const rawUpload = multer({
  storage,

  // Let multer accept first. We validate using sharp/heic-convert after upload.
  fileFilter: (_req, file, cb) => {
    console.log("[CHAT IMAGE RECEIVED]", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    cb(null, true);
  },

  limits: {
    fileSize: Math.max(MAX_BYTES, VOICE_MAX_BYTES),
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

      const oldPath = req.file.path;
      const oldFilename = req.file.filename;

      try {
        const inputBuffer = await getInputBufferForSharp(req.file);

        // Validate image content after possible HEIC conversion.
        await sharp(inputBuffer).metadata();

        const finalFilename = oldFilename.replace(/\.upload$/i, ".webp");
        const finalPath = path.join(req.file.destination, finalFilename);

        const compression = await compressImageBufferToTargetKB(
          inputBuffer,
          finalPath,
          {
            targetKB: TARGET_KB,
          },
        );

        deleteFileIfExists(oldPath);

        const stat = fs.statSync(finalPath);

        req.file.filename = finalFilename;
        req.file.path = finalPath;
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

        deleteFileIfExists(oldPath);

        return res.status(400).json({
          success: false,
          message:
            "Only valid image files are allowed. This image type could not be converted on the server.",
          error: compressionErr.message,
        });
      }
    });
  };
}

function messageMedia() {
  const multerFields = rawUpload.fields([
    { name: "chat_image", maxCount: 1 },
    { name: "chat_voice", maxCount: 1 },
  ]);

  return function messageMediaUpload(req, res, next) {
    multerFields(req, res, async function (err) {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message || "Media upload failed.",
          code: err.code,
          field: err.field,
        });
      }

      const imageFile = req.files?.chat_image?.[0] || null;
      const voiceFile = req.files?.chat_voice?.[0] || null;

      if (imageFile && voiceFile) {
        deleteFileIfExists(imageFile.path);
        deleteFileIfExists(voiceFile.path);
        return res.status(400).json({
          success: false,
          message: "Send either chat_image or chat_voice, not both.",
        });
      }

      if (voiceFile) {
        try {
          if (voiceFile.size > VOICE_MAX_BYTES) {
            throw new Error("Voice message exceeds the allowed size.");
          }
          const detected = await validateVoiceFile(voiceFile);
          const finalFilename = `${path.parse(voiceFile.filename).name}.${detected.ext}`;
          const finalPath = path.join(voiceFile.destination, finalFilename);

          if (finalPath !== voiceFile.path) {
            fs.renameSync(voiceFile.path, finalPath);
            voiceFile.filename = finalFilename;
            voiceFile.path = finalPath;
          }
          voiceFile.mimetype = detected.mime;
          req.file = voiceFile;
          return next();
        } catch (voiceErr) {
          deleteFileIfExists(voiceFile.path);
          return res.status(400).json({
            success: false,
            message: voiceErr.message || "Voice upload failed.",
          });
        }
      }

      if (!imageFile) return next();

      const oldPath = imageFile.path;
      try {
        if (imageFile.size > MAX_BYTES) {
          throw new Error("Chat image exceeds the allowed size.");
        }
        const inputBuffer = await getInputBufferForSharp(imageFile);
        await sharp(inputBuffer).metadata();
        const finalFilename = imageFile.filename.replace(/\.upload$/i, ".webp");
        const finalPath = path.join(imageFile.destination, finalFilename);
        const compression = await compressImageBufferToTargetKB(
          inputBuffer,
          finalPath,
          { targetKB: TARGET_KB },
        );
        deleteFileIfExists(oldPath);
        const stat = fs.statSync(finalPath);
        Object.assign(imageFile, {
          filename: finalFilename,
          path: finalPath,
          size: stat.size,
          mimetype: "image/webp",
          compression,
        });
        req.file = imageFile;
        return next();
      } catch (imageErr) {
        deleteFileIfExists(oldPath);
        return res.status(400).json({
          success: false,
          message: "Only valid image files are allowed.",
          error: imageErr.message,
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
  messageMedia,
  toWebPath,
  UPLOAD_ROOT,
  SUBFOLDERS,
  TARGET_KB,
  VOICE_MAX_BYTES,
  rawUpload,
};

module.exports = upload;
