const express = require("express");
const router = express.Router();

const {
  createRatingCtrl,
  getRatingSummaryCtrl,
} = require("../controllers/martRatingsController");

// POST /api/mart/ratings
router.post("/", createRatingCtrl);

// GET /api/mart/ratings/menu/:menu_id/summary
router.get("/menu/:menu_id/summary", getRatingSummaryCtrl);

module.exports = router;
