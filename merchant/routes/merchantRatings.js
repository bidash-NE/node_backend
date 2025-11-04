const express = require("express");
const router = express.Router();
const {
  getBusinessRatingsAutoCtrl,
  likeFoodRatingCtrl,
  unlikeFoodRatingCtrl,
  likeMartRatingCtrl,
  unlikeMartRatingCtrl,
} = require("../controllers/merchantRatingsController");

/* validators */
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

module.exports = router;
