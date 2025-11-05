// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
} = require("../controllers/systemNotificationController");

// Create new notification
router.post("/", createSystemNotification);

// Fetch all system notifications (admin)
router.get("/all", getAllSystemNotificationsController);

// Fetch notifications for a specific user (by role)
router.get("/:userId", getSystemNotificationsByUser);

module.exports = router;
