// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
  sendSmsToSingleUser,
  sendEmailToSingleUser,
  getSingleUserDeliveryLogsByUserIdController,
} = require("../controllers/systemNotificationController");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const readLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many requests. Please slow down.",
});

const sendLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: "Too many notification send requests. Please try again later.",
});

const createLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

// Existing
router.post("/", createLimiter, createSystemNotification);
router.get("/all", readLimiter, getAllSystemNotificationsController);

// Send to ONE user
router.post("/user/sms", sendLimiter, sendSmsToSingleUser);
router.post("/user/email", sendLimiter, sendEmailToSingleUser);

// Fetch single-user logs
router.get(
  "/user/logs/:target_user_id",
  readLimiter,
  getSingleUserDeliveryLogsByUserIdController,
);

// keep this LAST
router.get("/:userId", readLimiter, getSystemNotificationsByUser);

module.exports = router;
