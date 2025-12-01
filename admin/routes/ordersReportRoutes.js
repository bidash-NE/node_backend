// routes/ordersReportRoutes.js
const express = require("express");
const router = express.Router();
const {
  getFoodOrdersReport,
  getMartOrdersReport,
  getFoodMartRevenueReport,
} = require("../controllers/ordersReportController");

// Food / Mart ORDER reports (existing)
router.get("/food-orders", getFoodOrdersReport);
router.get("/mart-orders", getMartOrdersReport);

// NEW: combined Food + Mart revenue report
router.get("/food-mart-revenue", getFoodMartRevenueReport);

module.exports = router;
