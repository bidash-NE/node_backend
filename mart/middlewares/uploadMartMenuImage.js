// middleware/uploadMartMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

/** Root folder where all uploads are stored */
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** Ensure a directory exists (recursive) */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Derive a safe extension from original name and/or mimetype */
function safeExt(originalName = "", mimetype = "") {
  const fromName = (path.extname(originalName || "") || "").toLowerCase();
  if (fromName && fromName.length <= 6) return fromName;

  // fallback by mimetype
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/svg": ".svg",
  };
  return map[mimetype] || ".jpg";
}

/** Slugify base filename from item name (or fallback) */
function slugBase(v = "item") {
  return (
    (String(v) || "item")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "item"
  );
}

/** Allowed mimetypes for menu images */
const allowedMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/svg",
]);

/**
 * Factory: create a multer-based uploader for Mart menu images.
 * - subfolder: stored inside /uploads/<subfolder>
 * - fieldName: multipart field, defaults to "item_image"
 * - maxSizeMB: file size limit (MB), default 5MB
 */
function createMartMenuUploader({
  subfolder = "mart-menu",
  fieldName = "item_image",
  maxSizeMB = 5,
} = {}) {
  const DEST = path.join(UPLOAD_ROOT, subfolder);
  ensureDirSync(DEST);

  const storage = multer.diskStorage({
    destination: function (_req, _file, cb) {
      try {
        ensureDirSync(DEST);
        cb(null, DEST);
      } catch (e) {
        cb(e);
      }
    },
    filename: function (req, file, cb) {
      const ext = safeExt(file.originalname, file.mimetype);
      const base = slugBase(req.body?.item_name || "item");
      const unique = `${Date.now()}-${crypto.randomUUID()}`;
      cb(null, `${unique}-${base}${ext}`);
    },
  });

  const fileFilter = (_req, file, cb) => {
    if (allowedMimes.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only image files are allowed (png, jpg, webp, gif, svg)."));
  };

  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: maxSizeMB * 1024 * 1024, files: 1 },
  }).single(fieldName);

  /** Express middleware */
  const middleware = (req, res, next) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) return next(); // allow JSON-only requests
    uploader(req, res, (err) => {
      if (err) {
        err.statusCode = 400;
        return next(err);
      }
      return next();
    });
  };

  /** Convert multer file object → relative web path */
  const toWebPath = (fileObj) => {
    if (!fileObj || !fileObj.filename) return null;
    return `/uploads/${subfolder}/${fileObj.filename}`; // keep it relative; frontend will prefix host
  };

  return { middleware, toWebPath, DEST, subfolder, fieldName };
}

/**
 * Mount static serving for /uploads if you haven’t already.
 * Usage:
 *   const { serveUploads } = require('./middleware/uploadMartMenuImage');
 *   serveUploads(app); // AFTER creating express app
 */
function serveUploads(app) {
  ensureDirSync(UPLOAD_ROOT);
  app.use(
    "/uploads",
    require("express").static(UPLOAD_ROOT, { fallthrough: true })
  );
}

module.exports = {
  createMartMenuUploader,
  serveUploads,
  // For convenience: default mart uploader (same behavior as your previous file)
  uploadMartMenuImage: () => createMartMenuUploader().middleware,
};
