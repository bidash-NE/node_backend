// routes/notificationRoutes.js
const express = require("express");
const {
  listByBusinessId,
  getOne,
  markOneRead,
  markAllReadForBusiness,
  deleteOne,
} = require("../controllers/notificationController");

const router = express.Router();

/**
 * List notifications for a business (with pagination and unread filter)
 * GET /api/notifications/business/:businessId?limit=50&offset=0&unreadOnly=true
 */
router.get("/business/:businessId", listByBusinessId);

/**
 * Get a single notification by id
 * GET /api/notifications/:notificationId
 */
router.get("/:notificationId", getOne);

/**
 * Mark a single notification as read
 * PATCH /api/notifications/:notificationId/read
 */
router.patch("/:notificationId/read", markOneRead);

/**
 * Mark all notifications for a business as read
 * PATCH /api/notifications/business/:businessId/read-all
 */
router.patch("/business/:businessId/read-all", markAllReadForBusiness);

/**
 * Delete a notification by id
 * DELETE /api/notifications/:notificationId
 */
router.delete("/:notificationId", deleteOne);

module.exports = router;
