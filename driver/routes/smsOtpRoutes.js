const express = require("express");
const router = express.Router();
const { sendSmsOtp, verifySmsOtp } = require("../controllers/smsOtpController");

router.post("/send-otp-sms", sendSmsOtp);
router.post("/verify-otp-sms", verifySmsOtp);

module.exports = router;
