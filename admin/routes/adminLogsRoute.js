// routes/adminLogRoutes.js
const express = require("express");
const router = express.Router();
const { getAdminLogs } = require("../controllers/adminLogsController");

// GET /api/admin-logs
router.get("/", getAdminLogs);

module.exports = router;
