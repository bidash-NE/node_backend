// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
} = require("../controllers/systemNotificationController");

// POST — create and broadcast notification
router.post("/", createSystemNotification);

// GET — list all notifications (for admin view)
router.get("/all", getAllSystemNotificationsController);

// GET — list visible notifications for a specific user (based on role)
router.get("/:userId", getSystemNotificationsByUser);

module.exports = router;
