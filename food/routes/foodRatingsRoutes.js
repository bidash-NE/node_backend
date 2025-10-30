const express = require("express");
const router = express.Router();
const {
  createFoodRating,
  getFoodRatings,
} = require("../controllers/foodRatingsController");

router.post("/", createFoodRating);
router.get("/:business_id", getFoodRatings);

module.exports = router;
