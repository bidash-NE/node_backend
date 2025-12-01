// routes/pointSystemRoutes.js
const express = require("express");
const router = express.Router();

const pointSystemController = require("../controllers/pointSystemController");
const adminOnly = require("../middleware/adminAuth");

/* =======================================================
   POINT EARNING RULES (existing)
   /api/admin/point-system...
======================================================= */

// List all rules (optionally only active)
// GET /api/admin/point-system?onlyActive=true
router.get("/point-system", adminOnly, pointSystemController.getAllPointRules);

// Get single rule by id
// GET /api/admin/point-system/:id
router.get(
  "/point-system/:id",
  adminOnly,
  pointSystemController.getPointRuleById
);

// Create new rule
// POST /api/admin/point-system
// headers: Authorization: Bearer <access_token>
router.post("/point-system", adminOnly, pointSystemController.createPointRule);

// Update rule
// PUT /api/admin/point-system/:id
router.put(
  "/point-system/:id",
  adminOnly,
  pointSystemController.updatePointRule
);

// Delete rule
// DELETE /api/admin/point-system/:id
router.delete(
  "/point-system/:id",
  adminOnly,
  pointSystemController.deletePointRule
);

/* =======================================================
   POINT CONVERSION RULE (single-row config)
   /api/admin/point-conversion-rule...
======================================================= */

// Get current conversion rule
// GET /api/admin/point-conversion-rule
router.get(
  "/point-conversion-rule",
  adminOnly,
  pointSystemController.getPointConversionRule
);

// Create or replace conversion rule
// POST /api/admin/point-conversion-rule
router.post(
  "/point-conversion-rule",
  adminOnly,
  pointSystemController.createPointConversionRule
);

// Update conversion rule (partial)
// PUT /api/admin/point-conversion-rule
router.put(
  "/point-conversion-rule",
  adminOnly,
  pointSystemController.updatePointConversionRule
);

// Delete conversion rule
// DELETE /api/admin/point-conversion-rule
router.delete(
  "/point-conversion-rule",
  adminOnly,
  pointSystemController.deletePointConversionRule
);

module.exports = router;
