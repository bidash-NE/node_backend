// routes/userPointConversionRoutes.js
const express = require("express");
const router = express.Router();

const pointConversionController = require("../controllers/pointConversionController");
const userAuth = require("../middleware/auth"); // <- this must be the function from auth.js

// POST /api/user/points/convert
// body: { points: 100 }
router.post(
  "/points/convert",
  userAuth, // <- function
  pointConversionController.convertPointsToWallet // <- function
);

module.exports = router;
