// routes/pointSystemRoutes.js
const express = require("express");
const router = express.Router();

const pointSystemController = require("../controllers/pointSystemController");
const adminOnly = require("../middleware/adminAuth");

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

module.exports = router;
