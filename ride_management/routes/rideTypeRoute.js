const express = require("express");
const router = express.Router();
const rideTypeController = require("../controllers/rideTypeController");

// Create new ride type
router.post("/", rideTypeController.createRideType);

// Update ride type by id
router.put("/:id", rideTypeController.updateRideType);

// Get all ride types
router.get("/getall", rideTypeController.getAllRideTypes);

// Get one ride type by id
router.get("/:id", rideTypeController.getRideTypeById);

router.delete("/:ride_type_id", rideTypeController.deleteRideType);

module.exports = router;
