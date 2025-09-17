// routes/ordersReportRoutes.js
const express = require("express");
const router = express.Router();
const {
  getFoodOrdersReport,
  getMartOrdersReport,
} = require("../controllers/ordersReportController");

// Food report (owner_type = 'food')
router.get("/food-orders", getFoodOrdersReport);

// Mart report (owner_type = 'mart')
router.get("/mart-orders", getMartOrdersReport);

module.exports = router;
