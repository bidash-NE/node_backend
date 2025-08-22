// routes/martMenuBrowseRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/martMenuBrowseController");

// Grouped by category for a business (exclude empty)
router.get("/business/menu-grouped/:business_id", ctrl.getMartMenuGrouped);

module.exports = router;
