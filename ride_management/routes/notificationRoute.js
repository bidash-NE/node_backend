const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");

router.get("/all/:userId", notificationController.getAllNotifications);
router.get("/latest/:userId", notificationController.getLatestNotifications);
router.post("/add", notificationController.createNotification);
router.get("/unread/:userId", notificationController.getUnreadNotifications);
router.patch("/mark-all-read/:userId", notificationController.markAllAsRead);
router.patch("/mark-read/:id", notificationController.markOneAsRead);

module.exports = router;
