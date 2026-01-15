// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,

  // ✅ NEW: single user (by target_user_id)
  sendSmsToSingleUser,
  sendEmailToSingleUser,
} = require("../controllers/systemNotificationController");

// Existing
router.post("/", createSystemNotification);
router.get("/all", getAllSystemNotificationsController);

// ✅ NEW: send to ONE user (fetch email/phone from DB using target_user_id)
router.post("/user/sms", sendSmsToSingleUser);
router.post("/user/email", sendEmailToSingleUser);

// Existing: keep this LAST so it doesn’t catch "/user/sms" or "/user/email"
router.get("/:userId", getSystemNotificationsByUser);

module.exports = router;
