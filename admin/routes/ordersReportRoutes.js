// routes/ordersReportRoutes.js
const express = require("express");
const router = express.Router();
const {
  getFoodOrdersReport,
  getMartOrdersReport,
} = require("../controllers/ordersReportController");

// Example:
// GET /api/reports/food-orders?business_ids=26,27&status=CONFIRMED&date_from=2025-09-01&date_to=2025-09-17
router.get("/food-orders", getFoodOrdersReport);

// Example:
// GET /api/reports/mart-orders?business_ids=31&user_id=45
router.get("/mart-orders", getMartOrdersReport);

module.exports = router;
