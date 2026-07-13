const sharp = require('sharp');
const heicConvert = require('heic-convert');

// Aim for the middle of the 100-200KB range so we have headroom either side.
const TARGET_KB_DEFAULT = 150;
const MAX_TARGET_KB = 200;

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',

  // iPhone formats
  'image/heic',
  'image/heif',

  // fallback for some mobile/API clients
  'application/octet-stream',
]);

function isLikelyImage(file) {
  if (!file) return false;
  const mimetype = String(file.mimetype || '').toLowerCase();
  return allowedMimeTypes.has(mimetype);
}

function isHeicFile(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase();
  const ext = String(file?.originalname || '').toLowerCase();
  return mimetype === 'image/heic' || mimetype === 'image/heif' || ext.endsWith('.heic') || ext.endsWith('.heif');
}

async function getInputBuffer(file) {
  if (!isHeicFile(file)) return file.buffer;

  const jpegBuffer = await heicConvert({
    buffer: file.buffer,
    format: 'JPEG',
    quality: 0.9,
  });

  return Buffer.from(jpegBuffer);
}

// Iteratively lowers quality, then dimensions, until the encoded buffer
// fits within [targetKB, maxTargetKB]. Any source size (a few KB to tens of MB) converges here.
async function compressToTargetKB(inputBuffer, options = {}) {
  const {
    targetKB = TARGET_KB_DEFAULT,
    maxTargetKB = MAX_TARGET_KB,
    startQuality = 85,
    minQuality = 35,
    startWidth = 1600,
    startHeight = 1600,
    minWidth = 400,
    minHeight = 400,
  } = options;

  const targetBytes = targetKB * 1024;
  const maxBytes = maxTargetKB * 1024;

  // Throws if the buffer isn't a real, decodable image.
  await sharp(inputBuffer).metadata();

  let width = startWidth;
  let height = startHeight;
  let finalBuffer = null;
  let finalMeta = null;

  while (width >= minWidth && height >= minHeight) {
    let quality = startQuality;

    while (quality >= minQuality) {
      const buffer = await sharp(inputBuffer)
        .rotate()
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 6 })
        .toBuffer();

      finalBuffer = buffer;
      finalMeta = { width, height, quality, sizeKB: Number((buffer.length / 1024).toFixed(2)) };

      if (buffer.length <= targetBytes) {
        return { buffer, meta: finalMeta };
      }

      quality -= 5;
    }

    width = Math.floor(width * 0.85);
    height = Math.floor(height * 0.85);
  }

  if (!finalBuffer) {
    throw new Error('Image compression failed.');
  }

  // Couldn't hit the ideal target — as long as we're under the hard cap, ship it.
  if (finalBuffer.length <= maxBytes) {
    return { buffer: finalBuffer, meta: finalMeta };
  }

  throw new Error(`Could not compress image below ${maxTargetKB}KB.`);
}

async function compressUploadedFile(file, options = {}) {
  if (!isLikelyImage(file)) {
    throw new Error(`Only image files are allowed. Received mimetype=${file.mimetype}, file=${file.originalname}`);
  }

  const inputBuffer = await getInputBuffer(file);
  return compressToTargetKB(inputBuffer, options);
}

module.exports = {
  compressUploadedFile,
  compressToTargetKB,
  isLikelyImage,
  isHeicFile,
  TARGET_KB_DEFAULT,
  MAX_TARGET_KB,
};
