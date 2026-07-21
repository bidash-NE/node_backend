const express = require("express");
const router = express.Router();
const push = require("../controllers/pushController");

// ✅ Send to a single user_id
router.post("/send", push.sendToUser);

// ✅ Bulk send to many users
router.post("/send-bulk", push.sendBulkToUsers);

// ✅ Register push token
router.post("/register-token", push.registerToken);

// ✅ Remove push token
router.delete("/token", push.removeToken);

// ✅ Get user's push tokens
router.get("/tokens/:user_id", push.getUserTokens);

// ✅ Get notification history
router.get("/history/:user_id", push.getNotificationHistory);

// ✅ Broadcast to all users of a role (async job, poll status below)
router.post("/broadcast/users", push.broadcastToUsers);
router.post("/broadcast/merchants", push.broadcastToMerchants);
router.post("/broadcast/drivers", push.broadcastToDrivers);

// ✅ Poll broadcast job status
router.get("/broadcast/status/:job_id", push.getBroadcastStatus);

// ✅ Retry only the users a broadcast job failed to reach
router.post("/broadcast/retry/:job_id", push.retryBroadcastFailures);

module.exports = router;
