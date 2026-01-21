// routes/smsOtpRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { sendSmsOtp, verifySmsOtp } = require("../controllers/smsOtpController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const otpSendLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: "Too many SMS OTP requests. Please try again later.",
});

const otpVerifyLimiter = makeLimiter({
  windowMs: 30 * 60 * 1000, // 30 min
  max: 15,
  message: "Too many SMS OTP verification attempts. Please try again later.",
});

router.post("/send-otp-sms", otpSendLimiter, sendSmsOtp);
router.post("/verify-otp-sms", otpVerifyLimiter, verifySmsOtp);

module.exports = router;
