const express = require("express");
const router = express.Router();

const push = require("../controllers/pushController");

// Token management
router.post("/register", push.registerToken);
router.post("/unregister", push.unregisterToken);
router.get("/tokens/:user_id", push.listTokensForUser);

// Sending notifications
router.post("/send", push.sendToToken); // to a single Expo token
router.post("/send-to-user", push.sendToUser); // to all tokens of a user

// Optional: receipts check (if you send and want delivery results)
router.post("/receipts", push.getReceipts);

module.exports = router;
