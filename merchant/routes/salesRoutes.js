// routes/salesRoutes.js
const express = require("express");
const router = express.Router();

const { getTodaySales } = require("../controllers/salesController");

// GET /api/sales/today/:business_id
router.get("/today/:business_id", getTodaySales);

module.exports = router;
