// routes/appRatingRoutes.js  ✅ EDITED (ADMIN SIDE)
const express = require("express");
const router = express.Router();
const authUser = require("../middleware/auth");

const {
  createAppRatingController,
  listAppRatingsController,
  getAppRatingByIdController,
  updateAppRatingController,
  deleteAppRatingController,
  getAppRatingSummaryController,

  // ✅ NEW: reports (merchant ratings comments/replies)
  listReportedCommentsController,
  listReportedRepliesController,
  ignoreReportController,
  deleteReportedCommentController,
  deleteReportedReplyController,
} = require("../controllers/appRatingController");

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

router.get("/reports/comments", authUser, listReportedCommentsController);
router.get("/reports/replies", authUser, listReportedRepliesController);
router.post("/reports/:report_id/ignore", authUser, ignoreReportController);
router.delete(
  "/reports/:report_id/comment",
  authUser,
  deleteReportedCommentController
);
router.delete(
  "/reports/:report_id/reply",
  authUser,
  deleteReportedReplyController
);

// Get single rating
router.get("/:id", getAppRatingByIdController);

// Update rating
router.put("/:id", updateAppRatingController);

// Delete rating
router.delete("/:id", deleteAppRatingController);

module.exports = router;
