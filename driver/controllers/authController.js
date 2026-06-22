const OtpModel = require("../models/otpModel");
const EmailService = require("../services/emailService");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

/* =========================================================
   SEND EMAIL OTP

   This function does not check the users table.
   OTP is sent regardless of existing roles/accounts.
========================================================= */

exports.sendOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;

    if (!emailRaw) {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address.",
      });
    }

    if (!EmailService.isConfigured()) {
      return res.status(500).json({
        success: false,
        message:
          "SMTP is not configured. Check SMTP_HOST, SMTP_USER and SMTP_PASS.",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);

    /*
     * Do not check whether the email already exists.
     * Registration will perform the final duplicate validation.
     */

    const otp = OtpModel.generateOtp();

    await OtpModel.storeOtp(cleanEmail, otp, 300);

    const info = await EmailService.sendRegistrationOtp(cleanEmail, otp);

    if (!info?.accepted || info.accepted.length === 0) {
      await OtpModel.deleteOtp(cleanEmail);

      return res.status(500).json({
        success: false,
        message: "SMTP did not accept the recipient.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email.",
      email: cleanEmail,
    });
  } catch (error) {
    console.error("Send email OTP error:", {
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to send OTP. Please try again.",
    });
  }
};

/* =========================================================
   VERIFY EMAIL OTP
========================================================= */

exports.verifyOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const otpRaw = req.body?.otp;

    if (!emailRaw || !otpRaw) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required.",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address.",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = String(otpRaw).trim();

    const storedOtp = await OtpModel.getOtp(cleanEmail);

    if (!storedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired. Please request a new OTP.",
      });
    }

    if (String(storedOtp).trim() !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    await OtpModel.storeVerifiedFlag(cleanEmail, 900);

    await OtpModel.deleteOtp(cleanEmail);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      email: cleanEmail,
    });
  } catch (error) {
    console.error("Verify email OTP error:", {
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "OTP verification failed. Please try again.",
    });
  }
};
