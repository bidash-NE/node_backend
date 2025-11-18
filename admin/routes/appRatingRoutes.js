// routes/appRatingRoutes.js
const express = require("express");
const router = express.Router();

const {
  createAppRatingController,
  listAppRatingsController,
  getAppRatingByIdController,
  updateAppRatingController,
  deleteAppRatingController,
  getAppRatingSummaryController,
} = require("../controllers/appRatingController");

// Base path to mount in app.js/server.js:
// const appRatingRoutes = require("./routes/appRatingRoutes");
// app.use("/api/app-ratings", appRatingRoutes);

/**
 * POST   /api/app-ratings          → create new rating
 * GET    /api/app-ratings          → list ratings (admin)
 * GET    /api/app-ratings/summary  → stats (admin)
 * GET    /api/app-ratings/:id      → get one
 * PUT    /api/app-ratings/:id      → update
 * DELETE /api/app-ratings/:id      → delete
 */

// Create new app rating
router.post("/", createAppRatingController);

// List ratings
router.get("/", listAppRatingsController);

// Summary stats
router.get("/summary", getAppRatingSummaryController);

// Get single rating
router.get("/:id", getAppRatingByIdController);

// Update rating
router.put("/:id", updateAppRatingController);

// Delete rating
router.delete("/:id", deleteAppRatingController);

module.exports = router;
