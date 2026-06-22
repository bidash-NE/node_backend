const OtpModel = require("../models/otpModel");
const EmailService = require("../services/emailService");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

/* =========================================================
   SEND REGISTRATION EMAIL OTP

   OTP is sent regardless of whether the email already exists.
   Duplicate-account validation is handled during registration.
========================================================= */

exports.sendOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;

    if (!emailRaw) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address",
      });
    }

    if (!EmailService.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: "SMTP not configured. Check SMTP_HOST/SMTP_USER/SMTP_PASS",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = OtpModel.generateOtp();

    /*
     * Do not check whether the email is already registered.
     *
     * The OTP endpoint only verifies ownership of the email.
     * Registration will later decide whether the account can
     * be created.
     */

    await OtpModel.storeOtp(cleanEmail, otp, 300);

    const info = await EmailService.sendRegistrationOtp(cleanEmail, otp);

    if (!info?.accepted || info.accepted.length === 0) {
      /*
       * Remove the stored OTP when SMTP does not accept
       * the recipient.
       */
      await OtpModel.deleteOtp(cleanEmail);

      return res.status(500).json({
        success: false,
        message: "SMTP did not accept recipient",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email",
    });
  } catch (err) {
    console.error("Send OTP error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
      error: err?.message || String(err),
    });
  }
};

/* =========================================================
   VERIFY REGISTRATION EMAIL OTP
========================================================= */

exports.verifyOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const otpRaw = req.body?.otp;

    if (!emailRaw || !otpRaw) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);

    const otp = String(otpRaw).trim();

    const storedOtp = await OtpModel.getOtp(cleanEmail);

    if (!storedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired",
      });
    }

    if (String(storedOtp).trim() !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await OtpModel.storeVerifiedFlag(cleanEmail, 900);

    await OtpModel.deleteOtp(cleanEmail);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  } catch (err) {
    console.error("Verify OTP error:", err);

    return res.status(500).json({
      success: false,
      message: "OTP verification failed",
      error: err?.message || String(err),
    });
  }
};
