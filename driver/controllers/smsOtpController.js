const redis = require("../models/redisClient");
const db = require("../config/db");

const SMS_URL =
  process.env.SMS_URL || "https://grab.newedge.bt/sms/api/sms/send";
const SMS_MASTER_KEY = (process.env.SMS_MASTER_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "Taabdoe").trim();

function normalizePhone(input) {
  const raw = String(input || "").trim();
  const digits = raw.replace(/[^\d]/g, "");

  if (digits.length === 8) return `975${digits}`; // 17398976 -> 97517398976
  if (digits.length === 11 && digits.startsWith("975")) return digits; // 97517398976
  return null;
}

function makeOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ✅ FIXED: send SMS using x-api-key (not Content-Type)
async function sendViaGateway({ to, text, from }) {
  if (!SMS_MASTER_KEY) throw new Error("SMS_MASTER_KEY missing in .env");

  const resp = await fetch(SMS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SMS_MASTER_KEY, // ✅ correct header
    },
    body: JSON.stringify({ to, text, from }),
  });

  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
  }

  return bodyText;
}

// ✅ Send OTP SMS (registration)
exports.sendSmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "Invalid phone number" });

    // Optional: block if phone already registered
    const [rows] = await db.execute(
      "SELECT user_id FROM users WHERE phone = ? OR phone = ? LIMIT 1",
      [phone, phone]
    );
    if (rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Phone already registered. OTP not sent." });
    }

    // resend cooldown 30s
    const rlKey = `otp_sms_rl:${phone}`;
    if (await redis.get(rlKey)) {
      return res
        .status(429)
        .json({ error: "Please wait before requesting another OTP." });
    }

    const otp = makeOtp();

    await redis.set(`otp_sms:${phone}`, otp, { ex: 300 }); // 5 mins
    await redis.set(rlKey, "1", { ex: 30 });

    const text =
      `Registration Verification code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;
    const gatewayResp = await sendViaGateway({
      to: phone,
      text,
      from: SMS_FROM,
    });

    return res.status(200).json({
      message: "OTP sent via SMS",
      gateway: gatewayResp,
    });
  } catch (err) {
    console.error("SMS OTP send error:", err.message);
    return res.status(500).json({ error: "Failed to send SMS OTP" });
  }
};

// ✅ Verify OTP SMS
exports.verifySmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp || "").trim();

    if (!phone || !otp) {
      return res.status(400).json({ error: "Phone and OTP are required" });
    }

    const storedOtp = await redis.get(`otp_sms:${phone}`);
    if (!storedOtp) return res.status(410).json({ error: "OTP expired" });
    if (String(storedOtp).trim() !== otp)
      return res.status(401).json({ error: "Invalid OTP" });

    await redis.set(`verified_sms:${phone}`, "true", { ex: 900 }); // 15 mins
    await redis.del(`otp_sms:${phone}`);

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("SMS OTP verify error:", err.message);
    return res.status(500).json({ error: "OTP verification failed" });
  }
};
