// routes/ordersReportRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  getFoodOrdersReport,
  getMartOrdersReport,
  getFoodMartRevenueReport,
} = require("../controllers/ordersReportController");

const reportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many report requests. Please slow down.",
    }),
});

router.get("/food-orders", reportLimiter, getFoodOrdersReport);
router.get("/mart-orders", reportLimiter, getMartOrdersReport);

// ✅ NOW reads from food_mart_revenue table
router.get("/food-mart-revenue", reportLimiter, getFoodMartRevenueReport);

module.exports = router;
