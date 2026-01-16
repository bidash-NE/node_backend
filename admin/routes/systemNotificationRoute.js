// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,

  // ✅ single user send
  sendSmsToSingleUser,
  sendEmailToSingleUser,

  // ✅ NEW: fetch ONLY single-user logs by target_user_id
  getSingleUserDeliveryLogsByUserIdController,
} = require("../controllers/systemNotificationController");

// Existing
router.post("/", createSystemNotification);
router.get("/all", getAllSystemNotificationsController);

// ✅ send to ONE user
router.post("/user/sms", sendSmsToSingleUser);
router.post("/user/email", sendEmailToSingleUser);

// ✅ NEW: fetch single-user send logs by target_user_id
// GET /api/system-notifications/user/logs/:target_user_id?page=1&limit=20
router.get(
  "/user/logs/:target_user_id",
  getSingleUserDeliveryLogsByUserIdController
);

// keep this LAST
router.get("/:userId", getSystemNotificationsByUser);

module.exports = router;
