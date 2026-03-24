const express = require("express");
const router = express.Router();
const controller = require("../controllers/contactMessageController");
const { sendEmailController } = require("../controllers/emailController");

/* =======================================================
   PUBLIC ROUTES
======================================================= */

// Create contact message
router.post("/", controller.createMessage);

// Send email (separate clear endpoint)
router.post("/send-email", sendEmailController);

/* =======================================================
   ADMIN ROUTES
======================================================= */

// Get all messages
router.get("/", controller.getAllMessages);

// Get single message
router.get("/:id", controller.getMessageById);

// Update status
router.patch("/:id/status", controller.updateStatus);

// Delete message
router.delete("/:id", controller.deleteMessage);

module.exports = router;
