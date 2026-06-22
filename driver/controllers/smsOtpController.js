/* =========================================================
   SEND REGISTRATION SMS OTP

   This function does not check the users table.
   OTP is sent regardless of existing roles/accounts.
========================================================= */

exports.sendSmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number.",
      });
    }

    /*
     * Do not query prisma.users here.
     *
     * Registration will later validate whether the requested
     * phone + role combination is allowed.
     */

    const otpKey = `otp_sms:${phone}`;
    const rateLimitKey = `otp_sms_rl:${phone}`;

    const rateLimited = await redis.get(rateLimitKey);

    if (rateLimited) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP.",
      });
    }

    const otp = makeOtp();

    await redis.set(otpKey, otp, {
      ex: 300,
    });

    await redis.set(rateLimitKey, "1", {
      ex: 30,
    });

    const text =
      `Registration Verification Code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    const gatewayResponse = await sendViaGateway({
      to: phone,
      text,
      from: SMS_FROM,
    });

    return res.status(200).json({
      success: true,
      message: "OTP sent via SMS.",
      phone: maskPhone(phone),
      ...(process.env.NODE_ENV !== "production"
        ? {
            gateway: gatewayResponse,
          }
        : {}),
    });
  } catch (error) {
    console.error("SMS OTP send error:", {
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to send SMS OTP. Please try again.",
    });
  }
};

/* =========================================================
   VERIFY REGISTRATION SMS OTP
========================================================= */

exports.verifySmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    const otp = String(req.body?.otp || "").trim();

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP are required.",
      });
    }

    const otpKey = `otp_sms:${phone}`;

    const storedOtp = await redis.get(otpKey);

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

    /*
     * Verified status is attached only to the phone.
     * The final registration handles the requested role.
     */
    await redis.set(`verified_sms:${phone}`, "true", {
      ex: 900,
    });

    await redis.del(otpKey);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      phone: maskPhone(phone),
    });
  } catch (error) {
    console.error("SMS OTP verification error:", {
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "OTP verification failed. Please try again.",
    });
  }
};
