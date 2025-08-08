const express = require("express");
const router = express.Router();
const { updateDriverLocation } = require("../controllers/driverController");

// Route to update driver location
router.put("/update-location", updateDriverLocation);

module.exports = router;
