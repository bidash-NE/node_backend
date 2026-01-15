// routes/merchantRatingsRoutes.js ✅ FULL + WORKING (MERCHANT SIDE)
const express = require("express");
const router = express.Router();

const authUser = require("../middlewares/authUser");

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

  // ✅ reports
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
  validateBusinessIdParam,
  getBusinessRatingsAutoCtrl
);

/* ---------- likes ---------- */
/**
 * FOOD:
 *  POST /api/merchant/ratings/food/:rating_id/like
 *  POST /api/merchant/ratings/food/:rating_id/unlike
 */
router.post(
  "/ratings/food/:rating_id/like",
  validateRatingIdParam,
  likeFoodRatingCtrl
);
router.post(
  "/ratings/food/:rating_id/unlike",
  validateRatingIdParam,
  unlikeFoodRatingCtrl
);

/**
 * MART:
 *  POST /api/merchant/ratings/mart/:rating_id/like
 *  POST /api/merchant/ratings/mart/:rating_id/unlike
 */
router.post(
  "/ratings/mart/:rating_id/like",
  validateRatingIdParam,
  likeMartRatingCtrl
);
router.post(
  "/ratings/mart/:rating_id/unlike",
  validateRatingIdParam,
  unlikeMartRatingCtrl
);

/* ---------- delete rating + replies ---------- */
/**
 * DELETE /api/merchant/ratings/:type/:rating_id
 * Auth required
 */
router.delete(
  "/ratings/:type/:rating_id",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  deleteRatingWithRepliesCtrl
);

/* ---------- replies (Redis-backed) ---------- */
/**
 * POST /api/merchant/ratings/:type/:rating_id/replies
 * Body: { text }
 * Auth required
 */
router.post(
  "/ratings/:type/:rating_id/replies",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  createRatingReplyCtrl
);

/**
 * GET /api/merchant/ratings/:type/:rating_id/replies?page=1&limit=20
 */
router.get(
  "/ratings/:type/:rating_id/replies",
  validateRatingTypeParam,
  validateRatingIdParam,
  listRatingRepliesCtrl
);

/**
 * DELETE /api/merchant/ratings/replies/:reply_id
 * Auth required
 */
router.delete(
  "/ratings/:type/replies/:reply_id",
  authUser,
  validateReplyIdParam,
  deleteRatingReplyCtrl
);

/* ---------- ✅ REPORTS ---------- */
/**
 * Report a COMMENT (rating) (food or mart)
 * POST /api/merchant/ratings/:type/:rating_id/report
 * Body: { reason: "..." }
 * Auth required
 */
router.post(
  "/ratings/:type/:rating_id/report",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  reportRatingCtrl
);

/**
 * Report a REPLY (food or mart)
 * POST /api/merchant/ratings/:type/replies/:reply_id/report
 * Body: { reason: "..." }
 * Auth required
 *
 * ✅ Fixes: Cannot POST /api/merchant/ratings/food/replies/11/report
 */
router.post(
  "/ratings/:type/replies/:reply_id/report",
  authUser,
  validateRatingTypeParam,
  validateReplyIdParam,
  reportReplyCtrl
);

module.exports = router;
