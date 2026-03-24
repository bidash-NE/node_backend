const express = require("express");
const router = express.Router();
const controller = require("../controllers/contactMessageController");

/* =======================================================
   PUBLIC ROUTE
======================================================= */
router.post("/", controller.createMessage);

/* =======================================================
   ADMIN ROUTES
======================================================= */
router.get("/", controller.getAllMessages);
router.get("/:id", controller.getMessageById);
router.patch("/:id/status", controller.updateStatus);
router.delete("/:id", controller.deleteMessage);

module.exports = router;
