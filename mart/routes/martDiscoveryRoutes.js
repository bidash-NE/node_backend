// routes/martDiscoveryRoute.js
const express = require("express");
const router = express.Router();

const {
  listMartBusinessesByBusinessTypeIdCtrl,
} = require("../controllers/martDiscoveryByIdController");

// Fetch MART businesses by business_type_id (no category lookup)
// Example: GET /api/mart/business-types/3/businesses
router.get(
  "/business-types/businesses/:business_type_id",
  listMartBusinessesByBusinessTypeIdCtrl
);

module.exports = router;
