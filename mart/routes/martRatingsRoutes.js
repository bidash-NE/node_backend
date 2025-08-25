// routes/martRatingsRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/martRatingsController");

// Create/Update rating
router.post("/", ctrl.createOrUpdateMartRating);

// Get ratings for a menu item (with aggregates)
router.get("/:menu_id", ctrl.getMartRatings);

module.exports = router;
