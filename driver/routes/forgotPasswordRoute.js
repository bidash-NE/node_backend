const express = require("express");
const router = express.Router();
const controller = require("../controllers/forgotPasswordController");

router.post("/send-otp", controller.sendOtp);
router.post("/verify-otp", controller.verifyOtp);

router.post("/send-otp-sms", controller.sendOtpSms);
router.post("/verify-otp-sms", controller.verifyOtpSms);

router.post("/reset-password", controller.resetPassword);

module.exports = router;
