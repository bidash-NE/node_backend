const express = require("express");
const router = express.Router();
const rideRequestController = require("../controllers/riderRequestController");
const { rideRequestLimiter } = require("../middleware/rateLimiter");
router.post("/request", rideRequestLimiter, rideRequestController.requestRide);
router.get("/:request_id", rideRequestController.getRiderRequestById);
router.get("/rider/:rider_id", rideRequestController.getRiderRequestByRiderId);

router.get("/popular/locations", rideRequestController.getPopularLocations);

module.exports = router;
