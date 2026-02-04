// src/routes/chatUpload.js
import path from "node:path";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import mime from "mime-types";

export function makeChatUploadRouter(publicBase = "grablike/uploads") {
  const router = express.Router();

  const UP_DIR = path.join(process.cwd(), "uploads", "chat");
  fs.mkdirSync(UP_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype) || "jpg";
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
      const rel = path.posix.join("chat", req.file.filename);
      const url = `${publicBase.replace(/\/+$/, "")}/${rel}`; // e.g. /uploads/chat/xxx.jpg
      return res.json({ ok: true, url });
    } catch (e) {
      console.error("[chat upload] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  return router;
}
