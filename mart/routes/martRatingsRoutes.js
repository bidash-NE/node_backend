const express = require("express");
const router = express.Router();
const {
  createMartRating,
  getMartRatings,
} = require("../controllers/martRatingsController");

router.post("/", createMartRating);
router.get("/:business_id", getMartRatings);

module.exports = router;
