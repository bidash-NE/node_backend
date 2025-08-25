// routes/foodRatingsRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/foodRatingsController");

// Create/Update rating
router.post("/", ctrl.createOrUpdateFoodRating);

// Get ratings for a menu item (with aggregates)
router.get("/:menu_id", ctrl.getFoodRatings);

module.exports = router;
