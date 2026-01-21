// routes/merchantRatingsRoutes.js
const express = require("express");
const router = express.Router();
const limit = require("express-rate-limit");
const authUser = require("../middlewares/authUser");

/* ---------------- rate limit helpers ---------------- */
const makeLimiter = ({ windowMs, max, message, key = "ip" }) =>
  limit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,

    // key: "ip" | "user"
    keyGenerator: (req) => {
      if (key === "user") {
        // adjust these to match your authUser payload shape
        const uid =
          req.user?.user_id ??
          req.user?.id ??
          req.user?.userId ??
          req.user?.merchant_id;

        return uid ? `user:${uid}` : `ip:${req.ip}`;
      }
      return req.ip;
    },

    handler: (req, res) => {
      // express-rate-limit attaches req.rateLimit in v6+
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

/* ---------------- rate limiters (tune as you like) ---------------- */
// Read/list endpoints (higher)
const ratingsListLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 15,
  message: "Too many requests. Please slow down.",
  key: "ip",
});

// Likes/unlikes (bursty)
const likeLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 15,
  message: "Too many like/unlike actions. Please try again shortly.",
  key: "user", // per-user is nicer if auth exists; falls back to IP
});

// Replies create (tighter)
const replyCreateLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 15,
  message: "Too many replies created. Please try again later.",
  key: "user",
});

// Delete actions (tight)
const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 15,
  message: "Too many delete actions. Please try again later.",
  key: "user",
});

// Reports (very tight)
const reportLimiter = makeLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 15,
  message:
    "You have reached the report limit for today. Please try again later.",
  key: "user",
});

/* ---------- controllers ---------- */
const {
  getBusinessRatingsAutoCtrl,

  likeFoodRatingCtrl,
  unlikeFoodRatingCtrl,
  likeMartRatingCtrl,
  unlikeMartRatingCtrl,

  createRatingReplyCtrl,
  listRatingRepliesCtrl,
  deleteRatingReplyCtrl,
  deleteRatingWithRepliesCtrl,

  reportRatingCtrl,
  reportReplyCtrl,
} = require("../controllers/merchantRatingsController");

/* ---------- validators ---------- */
const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

const validateRatingIdParam = (req, res, next) => {
  const rid = Number(req.params.rating_id);
  if (Number.isFinite(rid) && rid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid rating_id" });
};

const validateReplyIdParam = (req, res, next) => {
  const rid = Number(req.params.reply_id);
  if (Number.isFinite(rid) && rid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid reply_id" });
};

const validateRatingTypeParam = (req, res, next) => {
  const t = String(req.params.type || "").toLowerCase();
  if (t === "food" || t === "mart") {
    req.params.type = t;
    return next();
  }
  return res.status(400).json({
    success: false,
    message: "Invalid rating type. Expected 'food' or 'mart'.",
  });
};

/* ---------- ratings list ---------- */
/**
 * GET /api/merchant/ratings/:business_id?page=1&limit=20
 */
router.get(
  "/ratings/:business_id",
  ratingsListLimiter,
  validateBusinessIdParam,
  getBusinessRatingsAutoCtrl,
);

/* ---------- likes ---------- */
router.post(
  "/ratings/food/:rating_id/like",
  likeLimiter,
  validateRatingIdParam,
  likeFoodRatingCtrl,
);
router.post(
  "/ratings/food/:rating_id/unlike",
  likeLimiter,
  validateRatingIdParam,
  unlikeFoodRatingCtrl,
);

router.post(
  "/ratings/mart/:rating_id/like",
  likeLimiter,
  validateRatingIdParam,
  likeMartRatingCtrl,
);
router.post(
  "/ratings/mart/:rating_id/unlike",
  likeLimiter,
  validateRatingIdParam,
  unlikeMartRatingCtrl,
);

/* ---------- delete rating + replies ---------- */
router.delete(
  "/ratings/:type/:rating_id",
  authUser,
  deleteLimiter,
  validateRatingTypeParam,
  validateRatingIdParam,
  deleteRatingWithRepliesCtrl,
);

/* ---------- replies ---------- */
router.post(
  "/ratings/:type/:rating_id/replies",
  authUser,
  replyCreateLimiter,
  validateRatingTypeParam,
  validateRatingIdParam,
  createRatingReplyCtrl,
);

router.get(
  "/ratings/:type/:rating_id/replies",
  ratingsListLimiter,
  validateRatingTypeParam,
  validateRatingIdParam,
  listRatingRepliesCtrl,
);

router.delete(
  "/ratings/:type/replies/:reply_id",
  authUser,
  deleteLimiter,
  validateRatingTypeParam, // ✅ strongly recommended since :type exists
  validateReplyIdParam,
  deleteRatingReplyCtrl,
);

/* ---------- reports ---------- */
router.post(
  "/ratings/:type/:rating_id/report",
  authUser,
  reportLimiter,
  validateRatingTypeParam,
  validateRatingIdParam,
  reportRatingCtrl,
);

router.post(
  "/ratings/:type/replies/:reply_id/report",
  authUser,
  reportLimiter,
  validateRatingTypeParam,
  validateReplyIdParam,
  reportReplyCtrl,
);

module.exports = router;
