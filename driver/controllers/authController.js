const redis = require("../models/redisClient");
const transporter = require("../config/mailer");

// ✅ Send OTP
exports.sendOtp = async (req, res) => {
  const { email } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // ✅ Correct usage with Upstash Redis
    await redis.set(`otp:${email}`, otp, { ex: 300 });

    await transporter.sendMail({
      from: `"Ride App" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is: ${otp}. It will expire in 5 minutes.`,
    });

    res.status(200).json({ message: "OTP sent to email" });
    // console.log("otp send successfully");
  } catch (err) {
    console.error("Error sending OTP:", err.message);
    res.status(500).json({ error: "Failed to send OTP" });
  }
};

// ✅ Verify OTP
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp)
    return res.status(400).json({ error: "Email and OTP are required" });

  try {
    const storedOtp = await redis.get(`otp:${email}`);

    // console.log("Redis stored OTP:", storedOtp);
    // console.log("User input OTP:", otp);

    if (!storedOtp) {
      return res.status(410).json({ error: "OTP expired" });
    }

    if (storedOtp?.toString().trim() !== otp?.toString().trim()) {
      return res.status(401).json({ error: "Invalid OTP" });
    }

    // ✅ Mark email as verified
    await redis.set(`verified:${email}`, "true", { ex: 900 }); // 15 mins
    await redis.del(`otp:${email}`); // clear OTP

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("OTP verification error:", err);
    return res.status(500).json({ error: "OTP verification failed" });
  }
};
