const express = require("express");
const router = express.Router();
const push = require("../controllers/pushController");

// ✅ Send to a single user_id (your JSON shape)
router.post("/send", push.sendToUserFromDb);

// ✅ Bulk send to many users
router.post("/send-bulk", push.sendBulkToUsersFromDb);

module.exports = router;
