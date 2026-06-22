// controllers/smsOtpController.js

const { prisma } = require("../lib/prisma.js");
const redis = require("../models/redisClient");
const jwt = require("jsonwebtoken");

const SMS_URL = process.env.SMS_URL;
const SMS_MASTER_KEY = (process.env.SMS_MASTER_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "").trim();

/* ===================== COMMON HELPERS ===================== */

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;

  return Number(value);
}

function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}

function normalizePhone(input) {
  const raw = String(input || "").trim();
  const digits = raw.replace(/[^\d]/g, "");

  if (digits.length === 8) {
    return `975${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("975")) {
    return digits;
  }

  return null;
}

function normalizePhoneForDbVariants(input) {
  const phone = normalizePhone(input);

  if (!phone) {
    return [];
  }

  return Array.from(new Set([phone, `+${phone}`]));
}

function normalizeEmail(input) {
  const email = String(input || "")
    .trim()
    .toLowerCase();

  return email || null;
}

function safeDeviceId(input) {
  const deviceId = String(input || "").trim();

  return deviceId || null;
}

function makeOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function maskPhone(phone) {
  const value = String(phone || "");

  if (value.length <= 4) {
    return value;
  }

  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function truthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === null || value === undefined) return false;

  const normalized = String(value).trim().toLowerCase();

  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "y"
  );
}

function isOne(value) {
  return value === true || Number(value) === 1;
}

function isZero(value) {
  return value === false || Number(value) === 0;
}

function isAdminRole(role) {
  const normalizedRole = String(role || "")
    .toLowerCase()
    .trim();

  return (
    normalizedRole === "admin" ||
    normalizedRole === "super admin" ||
    normalizedRole === "super_admin" ||
    normalizedRole === "superadmin" ||
    normalizedRole === "finance"
  );
}

/* ===================== SMS GATEWAY ===================== */

async function sendViaGateway({ to, text, from }) {
  if (!SMS_MASTER_KEY) {
    throw new Error("SMS_MASTER_KEY missing in .env");
  }

  if (!SMS_URL) {
    throw new Error("SMS_URL missing in .env");
  }

  if (!from) {
    throw new Error("SMS_FROM missing in .env");
  }

  console.log("Attempting to send SMS to URL:", SMS_URL);

  console.log("Phone number:", to);

  try {
    const response = await fetch(SMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SMS_MASTER_KEY,
      },
      body: JSON.stringify({
        to,
        text,
        from,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`SMS gateway error ${response.status}: ${responseText}`);
    }

    return responseText;
  } catch (error) {
    console.error("Fetch error details:", {
      name: error?.name,
      message: error?.message,
      cause: error?.cause,
      code: error?.code,
    });

    throw error;
  }
}

/* ===================== USER LOOKUP HELPERS ===================== */

async function findSingleUserForDeviceChange({ phone, email }) {
  let users = [];

  if (email) {
    users = await prisma.$queryRaw`
      SELECT
        user_id,
        user_name,
        phone,
        email,
        role,
        is_active,
        is_verified
      FROM users
      WHERE LOWER(email) = ${email}
      ORDER BY user_id DESC
      LIMIT 2
    `;
  } else {
    const phoneVariants = normalizePhoneForDbVariants(phone);

    if (!phoneVariants.length) {
      return {
        ok: false,
        status: 400,
        message: "Invalid phone number.",
      };
    }

    users = await prisma.users.findMany({
      where: {
        OR: phoneVariants.map((phoneVariant) => ({
          phone: phoneVariant,
        })),
      },
      select: {
        user_id: true,
        user_name: true,
        phone: true,
        email: true,
        role: true,
        is_active: true,
        is_verified: true,
      },
      orderBy: {
        user_id: "desc",
      },
      take: 2,
    });
  }

  if (!users.length) {
    return {
      ok: false,
      status: 404,
      message:
        "No account found with this email or phone number. Please check and try again.",
    };
  }

  if (users.length > 1) {
    return {
      ok: false,
      status: 409,
      message:
        "Multiple accounts found with this information. Please contact support.",
    };
  }

  const user = users[0];

  user.user_id = toNumber(user.user_id);

  return {
    ok: true,
    user,
  };
}

async function validateUserCanLogin(user) {
  if (isZero(user.is_active)) {
    return {
      ok: false,
      status: 403,
      message:
        "Your account has been deactivated. Please contact support for assistance.",
    };
  }

  if (user.role === "driver") {
    const driverRecord = await prisma.drivers.findFirst({
      where: {
        user_id: user.user_id,
      },
      select: {
        approval_status: true,
      },
    });

    const status = driverRecord?.approval_status ?? "pending";

    if (status === "pending") {
      return {
        ok: false,
        status: 403,
        message:
          "Your registration is under review. You will be notified once approved.",
      };
    }

    if (status === "rejected") {
      return {
        ok: false,
        status: 403,
        message:
          "Your registration was not approved. Please contact support for more information.",
      };
    }
  }

  return {
    ok: true,
  };
}

/* ===================== NORMAL LOGIN RESPONSE BUILDER ===================== */

async function buildNormalLoginResponse({ user, deviceId, desktop = false }) {
  const roleLower = String(user.role || "")
    .toLowerCase()
    .trim();

  const isMerchant = roleLower === "merchant";

  const isFinance = roleLower === "finance";

  const adminNoDevice = isAdminRole(user.role);

  const merchantDesktopNoDevice = isMerchant && desktop === true;

  const financeNoDevice = isFinance && desktop === true;

  let owner_type = null;
  let business_id = null;
  let business_name = null;
  let business_logo = null;
  let address = null;

  if (isMerchant) {
    try {
      const business = await prisma.merchant_business_details.findFirst({
        where: {
          user_id: user.user_id,
        },
        orderBy: [
          {
            created_at: "desc",
          },
          {
            business_id: "desc",
          },
        ],
        select: {
          business_id: true,
          business_name: true,
          owner_type: true,
          business_logo: true,
          address: true,
        },
      });

      if (business) {
        owner_type = business.owner_type ?? null;

        business_id = business.business_id
          ? toNumber(business.business_id)
          : null;

        business_name = business.business_name ?? null;

        business_logo = business.business_logo ?? null;

        address = business.address ?? null;
      }
    } catch (error) {
      console.error("merchant extras fetch failed:", error?.message || error);
    }
  }

  const payload = {
    user_id: toNumber(user.user_id),
    role: user.role,
    user_name: user.user_name,
    phone: user.phone,
  };

  const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: "60m",
  });

  const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: "1440m",
  });

  const userResponse = {
    user_id: toNumber(user.user_id),
    user_name: user.user_name,
    phone: user.phone,
    role: user.role,
    email: user.email,
    is_verified: isOne(user.is_verified) ? 1 : 0,
  };

  if (isMerchant) {
    userResponse.owner_type = owner_type;

    userResponse.business_id = business_id;

    userResponse.business_name = business_name;

    userResponse.business_logo = business_logo;

    userResponse.address = address;

    userResponse.device_id =
      adminNoDevice || merchantDesktopNoDevice ? null : deviceId;
  } else if (isFinance) {
    userResponse.device_id = adminNoDevice || financeNoDevice ? null : deviceId;
  } else {
    userResponse.device_id = adminNoDevice ? null : deviceId;
  }

  return {
    success: true,
    message: "Login successful",
    token: {
      access_token,
      access_token_time: 60,
      refresh_token,
      refresh_token_time: 1440,
    },
    user: userResponse,
  };
}

/* ===================== REGISTRATION SMS OTP ===================== */

/*
 * This endpoint intentionally does not check the users table.
 *
 * It sends an OTP regardless of whether the phone is already
 * registered under any role.
 *
 * The registration controller will later validate whether the
 * requested phone and role combination is allowed.
 */
exports.sendSmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number",
      });
    }

    const rateLimitKey = `otp_sms_rl:${phone}`;

    if (await redis.get(rateLimitKey)) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP.",
      });
    }

    const otp = makeOtp();

    await redis.set(`otp_sms:${phone}`, otp, {
      ex: 300,
    });

    await redis.set(rateLimitKey, "1", {
      ex: 30,
    });

    const text =
      `Registration Verification code\n\n` +
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
      message: "OTP sent via SMS",
      gateway: gatewayResponse,
    });
  } catch (error) {
    console.error("SMS OTP send error:", error?.message || error);

    return res.status(500).json({
      success: false,
      message: "Failed to send SMS OTP",
    });
  }
};

exports.verifySmsOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    const otp = String(req.body?.otp || "").trim();

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone and OTP are required",
      });
    }

    const storedOtp = await redis.get(`otp_sms:${phone}`);

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

    await redis.set(`verified_sms:${phone}`, "true", {
      ex: 900,
    });

    await redis.del(`otp_sms:${phone}`);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  } catch (error) {
    console.error("SMS OTP verify error:", error?.message || error);

    return res.status(500).json({
      success: false,
      message: "OTP verification failed",
    });
  }
};

/* ===================== CHANGE DEVICE OTP SEND ===================== */

exports.changeDeviceOTP = async (req, res) => {
  try {
    const body = req.body || {};

    const phone = body.phone ? normalizePhone(body.phone) : null;

    const email = body.email ? normalizeEmail(body.email) : null;

    const deviceId = safeDeviceId(
      body.device_id ?? body.deviceID ?? body.deviceId ?? body.deviceid,
    );

    const desktop = truthy(body.desktop);

    if (!phone && !email) {
      return errorResponse(
        res,
        400,
        "Please provide either email or phone number.",
      );
    }

    if (!deviceId) {
      return errorResponse(res, 400, "New device information is required.");
    }

    const found = await findSingleUserForDeviceChange({
      phone,
      email,
    });

    if (!found.ok) {
      return errorResponse(res, found.status, found.message);
    }

    const user = found.user;

    const eligible = await validateUserCanLogin(user);

    if (!eligible.ok) {
      return errorResponse(res, eligible.status, eligible.message);
    }

    const roleLower = String(user.role || "")
      .toLowerCase()
      .trim();

    const isMerchant = roleLower === "merchant";

    const isFinance = roleLower === "finance";

    const adminNoDevice = isAdminRole(user.role);

    const merchantDesktopNoDevice = isMerchant && desktop === true;

    const financeNoDevice = isFinance && desktop === true;

    if (adminNoDevice || merchantDesktopNoDevice || financeNoDevice) {
      return errorResponse(
        res,
        400,
        "Device change OTP is not required for this account. Please login normally.",
      );
    }

    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: {
        user_id: user.user_id,
      },
      select: {
        device_id: true,
      },
    });

    const databaseDeviceId = deviceRecord?.device_id
      ? String(deviceRecord.device_id)
      : null;

    if (!databaseDeviceId) {
      return errorResponse(
        res,
        400,
        "No registered device found for this account. Please login normally.",
      );
    }

    if (databaseDeviceId === deviceId) {
      return errorResponse(
        res,
        400,
        "This device is already active for this account. Please login normally.",
      );
    }

    const smsPhone = normalizePhone(user.phone);

    if (!smsPhone) {
      return errorResponse(
        res,
        400,
        "No valid phone number is linked to this account.",
      );
    }

    const rateLimitKey = `change_device_otp_rl:${user.user_id}`;

    if (await redis.get(rateLimitKey)) {
      return errorResponse(
        res,
        429,
        "Please wait before requesting another device verification OTP.",
      );
    }

    const otp = makeOtp();

    const pendingPayload = {
      otp,
      user_id: user.user_id,
      device_id: deviceId,
      phone: smsPhone,
      purpose: "change_device",
      created_at: new Date().toISOString(),
    };

    await redis.set(
      `change_device_otp:${user.user_id}`,
      JSON.stringify(pendingPayload),
      {
        ex: 300,
      },
    );

    await redis.set(rateLimitKey, "1", {
      ex: 30,
    });

    const text =
      `Device Change Verification Code\n\n` +
      `${otp}\n\n` +
      `Use this code to verify your new device.\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    const gatewayResponse = await sendViaGateway({
      to: smsPhone,
      text,
      from: SMS_FROM,
    });

    return res.status(200).json({
      success: true,
      message: "OTP sent via SMS for device verification.",
      phone: maskPhone(smsPhone),
      ...(process.env.NODE_ENV !== "production"
        ? {
            gateway: gatewayResponse,
          }
        : {}),
    });
  } catch (error) {
    console.error("changeDeviceOTP error:", error?.message || error);

    return errorResponse(
      res,
      500,
      "Failed to send device verification OTP. Please try again.",
    );
  }
};

/* ===================== CHANGE DEVICE OTP VERIFY + LOGIN ===================== */

exports.changeDeviceOTPVerify = async (req, res) => {
  try {
    const body = req.body || {};

    const phone = body.phone ? normalizePhone(body.phone) : null;

    const email = body.email ? normalizeEmail(body.email) : null;

    const otp = String(body.otp || "").trim();

    const deviceId = safeDeviceId(
      body.device_id ?? body.deviceID ?? body.deviceId ?? body.deviceid,
    );

    const desktop = truthy(body.desktop);

    if (!phone && !email) {
      return errorResponse(
        res,
        400,
        "Please provide either email or phone number.",
      );
    }

    if (!deviceId) {
      return errorResponse(res, 400, "New device information is required.");
    }

    if (!otp) {
      return errorResponse(res, 400, "OTP is required.");
    }

    const found = await findSingleUserForDeviceChange({
      phone,
      email,
    });

    if (!found.ok) {
      return errorResponse(res, found.status, found.message);
    }

    const user = found.user;

    const eligible = await validateUserCanLogin(user);

    if (!eligible.ok) {
      return errorResponse(res, eligible.status, eligible.message);
    }

    const pendingKey = `change_device_otp:${user.user_id}`;

    const pendingRaw = await redis.get(pendingKey);

    if (!pendingRaw) {
      return errorResponse(res, 410, "OTP expired. Please request a new OTP.");
    }

    let pending;

    try {
      pending =
        typeof pendingRaw === "string" ? JSON.parse(pendingRaw) : pendingRaw;
    } catch (_parseError) {
      await redis.del(pendingKey);

      return errorResponse(res, 410, "OTP expired. Please request a new OTP.");
    }

    if (toNumber(pending.user_id) !== toNumber(user.user_id)) {
      await redis.del(pendingKey);

      return errorResponse(
        res,
        409,
        "OTP session mismatch. Please request a new OTP.",
      );
    }

    if (String(pending.device_id || "") !== deviceId) {
      return errorResponse(
        res,
        409,
        "OTP was requested for a different device. Please request a new OTP.",
      );
    }

    if (String(pending.otp || "").trim() !== otp) {
      return errorResponse(res, 401, "Invalid OTP.");
    }

    await redis.del(pendingKey);

    await prisma.all_device_ids.upsert({
      where: {
        user_id: user.user_id,
      },
      update: {
        device_id: deviceId,
        last_seen: new Date(),
      },
      create: {
        user_id: user.user_id,
        device_id: deviceId,
        last_seen: new Date(),
      },
    });

    await prisma.users.update({
      where: {
        user_id: user.user_id,
      },
      data: {
        is_verified: true,
        last_login: new Date(),
      },
    });

    user.is_verified = true;

    const loginResponse = await buildNormalLoginResponse({
      user,
      deviceId,
      desktop,
    });

    return res.status(200).json(loginResponse);
  } catch (error) {
    console.error("changeDeviceOTPVerify error:", error);

    return errorResponse(
      res,
      500,
      "Unable to verify device OTP. Please try again.",
    );
  }
};
