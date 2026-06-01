const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

/* ---------------- upload folders ---------------- */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.resolve(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // console.log("✅ Created folder:", dir);
  }
};

const logoImageDir = path.join(UPLOAD_ROOT, "logo_and_image");

makeDir(UPLOAD_ROOT);
makeDir(logoImageDir);

// console.log("📁 Admin upload root:", UPLOAD_ROOT);
// console.log("📁 Logo/Image upload folder:", logoImageDir);

/* ---------------- multer upload ---------------- */

/**
 * Important:
 * We do not reject in fileFilter.
 * Some clients like Hoppscotch may send a strange mimetype.
 * We validate properly inside controller after receiving file.
 */
const logoImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      makeDir(UPLOAD_ROOT);
      makeDir(logoImageDir);
      cb(null, logoImageDir);
    },

    filename: (_req, _file, cb) => {
      /**
       * We save compressed output as webp.
       * So the filename should also use .webp.
       */
      const fileName = `logo_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter: (_req, file, cb) => {
    console.log("[UPLOAD FILE RECEIVED]", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    cb(null, true);
  },

  limits: {
    fileSize: 5 * 1024 * 1024, // max upload before compression: 5MB
  },
});

/* ---------------- image validation ---------------- */

function isValidImageFile(file) {
  if (!file) return false;

  const allowedMimeTypes = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/octet-stream", // fallback for some API clients
  ]);

  const allowedExtensions = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
  ]);

  const mimetype = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  return allowedMimeTypes.has(mimetype) || allowedExtensions.has(ext);
}

/* ---------------- compression helper ---------------- */

/**
 * Compress image to target KB.
 *
 * This tries to get the image below targetKB.
 * If image is still above targetKB at minQuality,
 * it progressively reduces dimensions.
 */
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

  /**
   * First reduce quality.
   * If not enough, reduce dimensions and restart quality loop.
   */
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

        // console.log("[IMAGE COMPRESSED]", {
        //   file: inputPath,
        //   targetKB,
        //   ...finalMeta,
        // });

        return finalMeta;
      }

      quality -= 5;
    }

    width = Math.floor(width * 0.85);
    height = Math.floor(height * 0.85);
  }

  /**
   * If it could not reach targetKB, save the smallest generated version.
   * This avoids failing uploads for difficult images.
   */
  if (!finalBuffer) {
    throw new Error("Image compression failed.");
  }

  fs.writeFileSync(inputPath, finalBuffer);

//   console.log("[IMAGE COMPRESSED - ABOVE TARGET]", {
//     file: inputPath,
//     targetKB,
//     ...finalMeta,
//   });

  return finalMeta;
}

/* ---------------- exports ---------------- */

module.exports = {
  logoImageUpload,
  compressImageToTargetKB,
  isValidImageFile,
  UPLOAD_ROOT,
};