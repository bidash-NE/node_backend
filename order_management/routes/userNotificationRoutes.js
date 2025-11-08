const express = require("express");
const {
  listByUserId,
  getOne,
  markOneRead,
  markAllReadForUser,
  deleteOne,
} = require("../controllers/userNotificationController");

const router = express.Router();

/**
 * List notifications for a user (with pagination and unread filter)
 * GET /api/notifications/user/:userId?limit=50&offset=0&unreadOnly=true
 */
router.get("/user/:userId", listByUserId);

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
 * Mark all notifications for a user as read
 * PATCH /api/notifications/user/:userId/read-all
 */
router.patch("/user/:userId/read-all", markAllReadForUser);

/**
 * Delete a notification by id
 * DELETE /api/notifications/:notificationId
 */
router.delete("/:notificationId", deleteOne);

module.exports = router;
