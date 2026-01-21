// routes/updateMerchantRoutes.js (or whatever filename you use)
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const upload = require("../middlewares/upload");

const {
  updateMerchantBusiness,
  getMerchantBusiness,
} = require("../controllers/updateMerchantController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfterSeconds = req.rateLimit?.resetTime
        ? Math.max(
            0,
            Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000),
          )
        : undefined;

      return res.status(429).json({
        success: false,
        message,
        retry_after_seconds: retryAfterSeconds,
      });
    },
  });

/* ---------------- validators ---------------- */
const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

/* ---------------- limiters ---------------- */
// Read endpoint (higher)
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

// Update with upload (tighter)
const updateLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 20,
  message: "Too many update requests. Please try again later.",
});

// Update merchant business (upload) — limiter BEFORE multer
router.put(
  "/merchant-business/:business_id",
  validateBusinessIdParam,
  updateLimiter,
  upload.single("business_logo"),
  updateMerchantBusiness,
);

// Get merchant business
router.get(
  "/merchant-business/:business_id",
  readLimiter,
  validateBusinessIdParam,
  getMerchantBusiness,
);

module.exports = router;
