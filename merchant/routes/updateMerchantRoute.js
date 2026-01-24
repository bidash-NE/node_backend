// routes/updateMerchantRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit; // ✅ IPv6-safe key
const upload = require("../middlewares/upload");
const authUser = require("../middlewares/authUser");

const {
  updateMerchantBusiness,
  getMerchantBusiness,
  removeSpecialCelebration, // ✅ NEW
} = require("../controllers/updateMerchantController");

/* ---------------- rate limit helper (IPv6-safe) ---------------- */
const makeLimiter = ({ windowMs, max, message, key = "ip" }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,

    // key: "ip" | "user"
    keyGenerator: (req) => {
      const ipKey = ipKeyGenerator(req);

      if (key === "user") {
        const uid =
          req.user?.user_id ??
          req.user?.id ??
          req.user?.userId ??
          req.user?.merchant_id;

        return uid ? `user:${uid}` : `ip:${ipKey}`;
      }

      return ipKey;
    },

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
  key: "ip",
});

// Update with upload (tighter) — per user if token exists
const updateLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 20,
  message: "Too many update requests. Please try again later.",
  key: "user",
});

// Delete special celebration — per user
const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: "Too many delete requests. Please try again later.",
  key: "user",
});

/* ---------------- routes ---------------- */

// ✅ Update merchant business (upload) — auth first so limiter can be per-user
router.put(
  "/merchant-business/:business_id",
  authUser,
  validateBusinessIdParam,
  updateLimiter,
  upload.fields([
    { name: "business_logo", maxCount: 1 },
    { name: "license_image", maxCount: 1 },
  ]),
  updateMerchantBusiness,
);

// ✅ Get merchant business (public read)
router.get(
  "/merchant-business/:business_id",
  readLimiter,
  validateBusinessIdParam,
  getMerchantBusiness,
);

// ✅ Remove special celebration (Bearer token required)
router.delete(
  "/merchant-business/:business_id/special-celebration",
  authUser,
  validateBusinessIdParam,
  deleteLimiter,
  removeSpecialCelebration,
);

module.exports = router;

/**
 * ✅ IMPORTANT (server.js)
 * If behind nginx/cloudflare/load balancer, add once:
 *   app.set("trust proxy", 1);
 */
