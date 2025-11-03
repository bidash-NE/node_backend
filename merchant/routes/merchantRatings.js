const express = require("express");
const router = express.Router();
const {
  getBusinessRatingsAutoCtrl,
} = require("../controllers/merchantRatingsController");

/* validator */
const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
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

module.exports = router;
