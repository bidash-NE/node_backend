// middleware/uploadMartMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ✅ Root uploads directory (k8s: /uploads; local: ./uploads)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

/* ---------- utils ---------- */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeExt(originalName = "", mimetype = "") {
  const fromName = (path.extname(originalName || "") || "").toLowerCase();
  if (fromName && fromName.length <= 6) return fromName;
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
 * Factory for Mart menu uploader.
 * Stores files under `${UPLOAD_ROOT}/${subfolder}` (default: mart-menu)
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

  // Express middleware (skips if not multipart)
  const middleware = (req, res, next) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) return next();
    uploader(req, res, (err) => {
      if (err) {
        err.statusCode = 400;
        return next(err);
      }
      next();
    });
  };

  // Build a public web path like /uploads/mart-menu/<file>
  const toWebPath = (fileObj) => {
    if (!fileObj || !fileObj.filename) return null;
    return `/uploads/${subfolder}/${fileObj.filename}`;
  };

  return { middleware, toWebPath, DEST, subfolder, fieldName, UPLOAD_ROOT };
}

/**
 * Optional: mount static serving for /uploads once in your server.js
 *   const { serveUploads } = require("./middleware/uploadMartMenuImage");
 *   serveUploads(app);
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
  // Convenience: same behavior as before — use in routes as: uploadMartMenuImage()
  uploadMartMenuImage: () => createMartMenuUploader().middleware,
};
