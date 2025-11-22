// routes/rideTypeRoute.js
const express = require("express");
const router = express.Router();
const rideTypeController = require("../controllers/rideTypeController");
const { uploadRideTypeImage } = require("../middleware/uploadRideTypeImage");
const authAccessToken = require("../middleware/authAccessToken");

// Create new ride type (supports multipart/form-data with field 'image')
router.post("/", uploadRideTypeImage, rideTypeController.createRideType);

// Update ride type by id (supports multipart/form-data with field 'image')
router.put("/:id", uploadRideTypeImage, rideTypeController.updateRideType);

// Get all ride types
router.get("/getall", rideTypeController.getAllRideTypes);

// Get one ride type by id
router.get("/:id", rideTypeController.getRideTypeById);

// Delete ride type by id  ✅ param is :id
router.delete("/:id", authAccessToken, rideTypeController.deleteRideType);

module.exports = router;
