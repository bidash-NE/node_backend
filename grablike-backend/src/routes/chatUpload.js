// File: src/routes/chatUpload.js
import path from "node:path";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import mime from "mime-types";

export function makeChatUploadRouter(publicBase = "/uploads") {
  const router = express.Router();

  // ✅ Use mounted path in K8s (UPLOAD_ROOT=/uploads), fallback to local ./uploads
  const UP_ROOT =
    process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

  // ✅ Chat upload dir: <UPLOAD_ROOT>/chat
  const UP_DIR = path.join(UP_ROOT, "chat");
  fs.mkdirSync(UP_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) => {
      // derive extension from mimetype (fallback jpg)
      const ext = (mime.extension(file.mimetype) || "jpg").toString();
      const name = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      cb(null, name);
    },
  });

  const fileFilter = (_req, file, cb) => {
    if (!file.mimetype?.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  };

  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  });

  // POST /chat/upload  (form field: "file")
  router.post("/upload", upload.single("file"), (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ ok: false, error: "no_file" });

      // ✅ URL path returned (your server should serve /uploads as static)
      // Example: /uploads/chat/chat-xxxx.jpg
      const rel = path.posix.join("chat", req.file.filename);
      const base = String(publicBase || "/uploads").replace(/\/+$/, "");
      const url = `${base}/${rel}`;

      return res.json({
        ok: true,
        url,
        filename: req.file.filename,
        mime: req.file.mimetype,
        size: req.file.size,
      });
    } catch (e) {
      console.error("[chat upload] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  return router;
}
