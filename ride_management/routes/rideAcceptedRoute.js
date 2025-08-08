const express = require("express");
const router = express.Router();
const rideAcceptedController = require("../controllers/rideAcceptedController");

// POST /api/ride/accept
router.post("/accept", rideAcceptedController.acceptRide);
router.get(
  "/accept/:rider_id",
  rideAcceptedController.getAcceptedRideByRiderId
);

module.exports = router;
