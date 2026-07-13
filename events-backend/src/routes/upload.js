const router = require('express').Router();
const multer = require('multer');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const s3 = require('../../config/minio');
const { compressUploadedFile } = require('../middleware/imageCompression');

const MINIO_INTERNAL_URL = 'http://minio-service.default.svc.cluster.local:9000';
const BUCKET = 'events-uploads';

const upload = multer({
  storage: multer.memoryStorage(),
  // Accept large originals (phone photos, HEIC, etc) — compression brings them down to ~100-200KB.
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/', requireAuth, requireAdmin, upload.single('image'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image uploaded.' });
  }

  try {
    const { buffer, meta } = await compressUploadedFile(req.file);

    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/webp',
    }));

    const internalUrl = `${MINIO_INTERNAL_URL}/${BUCKET}/${key}`;
    const publicUrl = internalUrl.replace(MINIO_INTERNAL_URL, process.env.MINIO_PUBLIC_URL);

    res.json({ success: true, url: publicUrl, sizeKB: meta.sizeKB, width: meta.width, height: meta.height });
  } catch (err) {
    if (err.message?.startsWith('Only image files') || err.message?.startsWith('Could not compress')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
