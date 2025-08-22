// routes/martDiscoveryRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/martDiscoveryByIdController");

// Discover businesses by MART business_type_id
router.get(
  "/business-type/businesses/:business_type_id",
  ctrl.getBusinessesByBusinessTypeId
);

module.exports = router;
