// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
} = require("../controllers/systemNotificationController");

// Create new notification (in_app, email, sms – behaviour handled in controller)
router.post("/", createSystemNotification);

// Admin: fetch all IN_APP notifications from DB
router.get("/all", getAllSystemNotificationsController);

// User: fetch in_app notifications by role
router.get("/:userId", getSystemNotificationsByUser);

module.exports = router;
