// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getSystemNotificationsForUser,
} = require("../controllers/systemNotificationController");

// Create new system notification (admin / super admin only)
router.post("/", createSystemNotification);

// Fetch notifications for a user (based on their role)
router.get("/:userId", getSystemNotificationsForUser);

module.exports = router;
