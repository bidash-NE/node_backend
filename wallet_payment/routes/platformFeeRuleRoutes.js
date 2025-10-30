const express = require("express");
const router = express.Router();
const controller = require("../controllers/platformFeeRuleController");

// GET /api/platform-fee-rules/percent
router.get("/percent", controller.getFeePercentage);

module.exports = router;
