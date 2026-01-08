// routes/merchantRatingsRoutes.js
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

  // ✅ NEW: reports
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

/* ---------- existing ratings & likes ---------- */

/**
 * GET /api/merchant/ratings/:business_id?page=1&limit=20
 * Automatically picks food_ratings or mart_ratings based on merchant_business_details.owner_type
 * If owner_type='both' (or missing/unknown), merges both tables.
 */
router.get(
  "/ratings/:business_id",
  validateBusinessIdParam,
  getBusinessRatingsAutoCtrl
);

/**
 * FOOD rating like / unlike
 *  - POST /api/merchant/ratings/food/:rating_id/like
 *  - POST /api/merchant/ratings/food/:rating_id/unlike
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
 * MART rating like / unlike
 *  - POST /api/merchant/ratings/mart/:rating_id/like
 *  - POST /api/merchant/ratings/mart/:rating_id/unlike
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

router.delete(
  "/ratings/:type/:rating_id",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  deleteRatingWithRepliesCtrl
);

/* ---------- replies (Redis-backed) ---------- */

/**
 * Create a reply for a rating (food or mart).
 * POST /api/merchant/ratings/:type/:rating_id/replies
 *  Body: { text: "..." }
 *  Auth: user token (Bearer)
 */
router.post(
  "/ratings/:type/:rating_id/replies",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  createRatingReplyCtrl
);

/**
 * List replies for a rating.
 * GET /api/merchant/ratings/:type/:rating_id/replies?page=1&limit=20
 */
router.get(
  "/ratings/:type/:rating_id/replies",
  validateRatingTypeParam,
  validateRatingIdParam,
  listRatingRepliesCtrl
);

/**
 * Delete a reply by id (only creator can delete).
 * DELETE /api/merchant/ratings/replies/:reply_id
 *  Auth: user token (Bearer)
 */
router.delete(
  "/ratings/replies/:reply_id",
  authUser,
  validateReplyIdParam,
  deleteRatingReplyCtrl
);

/* ---------- ✅ NEW: reports (Redis-backed) ---------- */

/**
 * Report a rating comment
 * POST /api/merchant/ratings/:type/:rating_id/report
 * Body: { reason: "..." }
 * Auth: user token (Bearer)
 */
router.post(
  "/ratings/:type/:rating_id/report",
  authUser,
  validateRatingTypeParam,
  validateRatingIdParam,
  reportRatingCtrl
);

/**
 * Report a reply
 * POST /api/merchant/ratings/replies/:reply_id/report
 * Body: { reason: "..." }
 * Auth: user token (Bearer)
 */
router.post(
  "/ratings/replies/:reply_id/report",
  authUser,
  validateReplyIdParam,
  reportReplyCtrl
);

module.exports = router;
