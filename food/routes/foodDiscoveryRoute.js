// routes/foodDiscoveryRoute.js
const express = require("express");
const router = express.Router();

const {
  listFoodBusinessesByBusinessTypeIdCtrl,
} = require("../controllers/foodDiscoveryByIdController");

// Fetch FOOD businesses by business_type_id (no category lookup)
// Example: GET /api/food/business-types/3/businesses
router.get(
  "/business-types/businesses/:business_type_id",
  listFoodBusinessesByBusinessTypeIdCtrl
);

module.exports = router;
