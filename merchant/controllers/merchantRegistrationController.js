const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");
const cache = require("../services/cacheService");

const {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByEmail,
} = require("../models/merchantRegistrationModel");

/* ---------------- file path helpers ---------------- */

const toRelPath = (fileObj) => {
  if (!fileObj) return null;
  let p = String(fileObj.path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("uploads/");
  if (i !== -1) p = p.slice(i);
  p = p.replace(/^\/+/, "");
  return `/${p}`;
};

const fromBodyToStoredPath = (val) => {
  if (!val) return null;
  const s = String(val).trim();
  if (s.startsWith("/uploads/")) return s;
  if (s.startsWith("uploads/")) return `/${s}`;
  try {
    const u = new URL(s);
    return u.pathname || null;
  } catch {
    return null;
  }
};

/* ---------------- register ---------------- */
async function registerMerchant(req, res) {
  const files = req.files || {};

  /*
   * Remove files created during a failed registration.
   * This prevents unused compressed images from accumulating.
   */
  const removeUploadedFiles = () => {
    const uploadedFiles = Object.values(files)
      .flat()
      .filter(Boolean);

    for (const file of uploadedFiles) {
      if (!file?.path) {
        continue;
      }

      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (cleanupError) {
        console.error(
          "Failed to remove uploaded merchant file:",
          file.path,
          cleanupError?.message || cleanupError,
        );
      }
    }
  };

  try {
    const body = req.body || {};

    const normalizeBhutanPhone = (raw) => {
      if (raw === null || raw === undefined) {
        return null;
      }

      let phone = String(raw)
        .trim()
        .replace(/[^\d+]/g, "");

      if (!phone) {
        return null;
      }

      if (phone.startsWith("00")) {
        phone = `+${phone.slice(2)}`;
      }

      if (phone.startsWith("+975")) {
        return phone;
      }

      if (phone.startsWith("975")) {
        return `+${phone}`;
      }

      if (phone.startsWith("+")) {
        return phone;
      }

      return `+975${phone}`;
    };

    const normalizeEmail = (raw) => {
      if (raw === null || raw === undefined) {
        return null;
      }

      const email = String(raw).trim().toLowerCase();

      return email || null;
    };

    const toNumberOrNull = (value) => {
      if (
        value === undefined ||
        value === null ||
        String(value).trim() === ""
      ) {
        return null;
      }

      const numberValue = Number(value);

      return Number.isFinite(numberValue)
        ? numberValue
        : null;
    };

    const toLowerOrDefault = (value, defaultValue) => {
      const normalized =
        value !== undefined && value !== null
          ? String(value).trim()
          : "";

      return (normalized || defaultValue).toLowerCase();
    };

    const licenseImage = files.license_image?.[0]
      ? toRelPath(files.license_image[0])
      : fromBodyToStoredPath(body.license_image);

    const businessLogo = files.business_logo?.[0]
      ? toRelPath(files.business_logo[0])
      : fromBodyToStoredPath(body.business_logo);

    const bankQrCodeImage = files.bank_qr_code_image?.[0]
      ? toRelPath(files.bank_qr_code_image[0])
      : fromBodyToStoredPath(body.bank_qr_code_image);

    const normalizedPhone =
      normalizeBhutanPhone(body.phone);

    const normalizedEmail =
      normalizeEmail(body.email);

    const normalizedCid =
      body.cid !== null &&
      body.cid !== undefined &&
      String(body.cid).trim() !== ""
        ? String(body.cid).trim()
        : null;

    const password =
      body.password !== null &&
      body.password !== undefined
        ? String(body.password)
        : "";

    if (!normalizedPhone) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message: "A valid phone number is required.",
      });
    }

    if (!normalizedEmail) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    if (!normalizedCid) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message: "CID number is required.",
      });
    }

    if (!/^\d{11}$/.test(normalizedCid)) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message: "CID must contain exactly 11 digits.",
      });
    }

    if (!password) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message: "Password is required.",
      });
    }

    if (password.length < 6) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message:
          "Password must contain at least 6 characters.",
      });
    }

    /*
     * This endpoint always creates merchant accounts.
     * Do not trust a role supplied by the frontend.
     */
    const role = "merchant";

    let businessTypes;

    if (Array.isArray(body.business_types)) {
      businessTypes = body.business_types;
    } else if (
      typeof body.business_types === "string" &&
      body.business_types.trim()
    ) {
      businessTypes = body.business_types
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }

    const minimumFreeDeliveryAmount =
      body.min_amount_for_fd !== undefined &&
      body.min_amount_for_fd !== ""
        ? Number(body.min_amount_for_fd)
        : 0;

    if (
      !Number.isFinite(minimumFreeDeliveryAmount) ||
      minimumFreeDeliveryAmount < 0
    ) {
      removeUploadedFiles();

      return res.status(400).json({
        success: false,
        message:
          "Minimum amount for free delivery must be a valid non-negative number.",
      });
    }

    const payload = {
      user_name: body.user_name,
      email: normalizedEmail,
      phone: normalizedPhone,
      cid: normalizedCid,
      password,
      role,

      business_name: body.business_name,

      business_type_ids:
        body.business_type_ids ?? null,

      business_types: businessTypes,

      business_license_number:
        body.business_license_number,

      license_image: licenseImage,

      latitude: toNumberOrNull(body.latitude),
      longitude: toNumberOrNull(body.longitude),

      address: body.address || null,
      business_logo: businessLogo,

      delivery_option:
        body.delivery_option || "SELF",

      owner_type: toLowerOrDefault(
        body.owner_type,
        "individual",
      ),

      min_amount_for_fd:
        minimumFreeDeliveryAmount,

      bank_name: body.bank_name,

      account_holder_name:
        body.account_holder_name,

      account_number:
        body.account_number,

      bank_qr_code_image:
        bankQrCodeImage,

      special_celebration:
        body.special_celebration || null,

      special_celebration_discount_percentage:
        body.special_celebration_discount_percentage ??
        null,
    };

    const result =
      await registerMerchantModel(payload);

    return res.status(201).json({
      success: true,
      message: "Merchant registered successfully.",
      user_id: result.user_id,
      business_id: result.business_id,
      business_type_ids:
        result.business_type_ids,
      phone: normalizedPhone,
      email: normalizedEmail,
      cid: normalizedCid,
      role: "merchant",
    });
  } catch (error) {
    /*
     * Registration failed after Multer processed the files.
     * Remove those newly generated files.
     */
    removeUploadedFiles();

    console.error("Merchant registration error:", {
      message: error?.message,
      code: error?.code,
      meta: error?.meta,
      stack: error?.stack,
    });

    const message =
      error?.message ||
      "Merchant registration failed.";

    const isConflict =
      /already registered|already exists|already being used|choose a different password|same login credentials/i.test(
        message,
      );

    const isValidation =
      /required|invalid|must contain|must be|exactly|at least one|at least 6|business_type_ids|greater than|non-negative/i.test(
        message,
      );

    if (isConflict) {
      return res.status(409).json({
        success: false,
        message,
      });
    }

    if (isValidation) {
      return res.status(400).json({
        success: false,
        message,
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "Merchant registration failed. Please try again later.",
    });
  }
}



/* ---------------- update business details ---------------- */

async function updateMerchant(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    if (!Number.isInteger(business_id) || business_id <= 0) {
      return res.status(400).json({ error: "Invalid businessId" });
    }

    const f = req.files || {};
    const b = req.body || {};

    const newLicenseImage = f.license_image?.[0]
      ? toRelPath(f.license_image[0])
      : fromBodyToStoredPath(b.license_image);
    const newBusinessLogo = f.business_logo?.[0]
      ? toRelPath(f.business_logo[0])
      : fromBodyToStoredPath(b.business_logo);

    const updatePayload = {};

    [
      "business_name",
      "business_license_number",
      "address",
      "delivery_option",
      "owner_type",
      "opening_time",
      "closing_time",
      "kitchen_closing_time",
      "special_celebration",
      "special_celebration_discount_percentage",
    ].forEach((k) => {
      if (b[k] !== undefined) {
        updatePayload[k] =
          k === "owner_type" ? String(b[k]).toLowerCase() : b[k];
      }
    });

    if (b.license_image !== undefined || f.license_image?.length) {
      updatePayload.license_image = newLicenseImage;
    }

    if (b.business_logo !== undefined || f.business_logo?.length) {
      updatePayload.business_logo = newBusinessLogo;
    }

    if (typeof b.latitude !== "undefined") {
      updatePayload.latitude = b.latitude === "" ? null : Number(b.latitude);
    }

    if (typeof b.longitude !== "undefined") {
      updatePayload.longitude = b.longitude === "" ? null : Number(b.longitude);
    }

    // Handle holidays field
    if (b.holidays !== undefined) {
      const validDays = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      let holidays = [];
      if (Array.isArray(b.holidays)) {
        holidays = b.holidays.filter((day) => validDays.includes(day));
      } else if (typeof b.holidays === "string") {
        holidays = b.holidays
          .split(",")
          .map((s) => s.trim())
          .filter((day) => validDays.includes(day));
      }
      updatePayload.holidays = JSON.stringify(holidays);
    }

    if (b.business_type_ids !== undefined)
      updatePayload.business_type_ids = b.business_type_ids;

    if (b.business_types !== undefined) {
      updatePayload.business_types = Array.isArray(b.business_types)
        ? b.business_types
        : String(b.business_types)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
    }

    if (b.min_amount_for_fd !== undefined) {
      updatePayload.min_amount_for_fd = Number(b.min_amount_for_fd);
    }

    const out = await updateMerchantDetailsModel(business_id, updatePayload);

    return res.status(200).json({
      message: "Business details updated",
      business_id: out.business_id,
    });
  } catch (err) {
    console.error("updateMerchant error:", err.message);
    const isClientErr = /not found|invalid/i.test(err.message || "");
    return res
      .status(isClientErr ? 404 : 500)
      .json({ error: err.message || "Update failed" });
  }
}

/* ---------------- login (email + password ONLY) ---------------- */

async function loginByEmail(req, res) {
  try {
    const body = req.body || {};

    const email =
      body.email !== null && body.email !== undefined
        ? String(body.email).trim().toLowerCase()
        : "";

    const password =
      body.password !== null && body.password !== undefined
        ? String(body.password)
        : "";

    const deviceId =
      body.device_id !== null &&
      body.device_id !== undefined &&
      String(body.device_id).trim()
        ? String(body.device_id).trim()
        : null;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email address is required.",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required.",
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: "Device ID is required.",
      });
    }

    /*
     * This model function must filter by:
     *
     * email + role: "merchant"
     */
    const candidates = await findCandidatesByEmail(email);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No merchant account was found with this email address.",
      });
    }

    let pickedUser = null;

    for (const candidate of candidates) {
      if (!candidate?.password_hash) {
        continue;
      }

      const passwordMatches = await bcrypt.compare(
        password,
        candidate.password_hash,
      );

      if (passwordMatches) {
        pickedUser = candidate;
        break;
      }
    }

    if (!pickedUser) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password. Please try again.",
      });
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: pickedUser.user_id,
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
    });

    /*
     * Check user existence before accessing user.role.
     */
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Merchant account not found.",
      });
    }

    if (
      String(user.role || "")
        .trim()
        .toLowerCase() !== "merchant"
    ) {
      return res.status(403).json({
        success: false,
        message: "This account is not registered as a merchant.",
      });
    }

    if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact support.",
      });
    }

    /*
     * When already logged in, verify that the incoming device
     * matches the device stored for this merchant user_id.
     */
    if (user.is_verified === true) {
      const deviceRecord = await prisma.all_device_ids.findUnique({
        where: {
          user_id: user.user_id,
        },
        select: {
          device_id: true,
        },
      });

      const storedDeviceId = deviceRecord?.device_id
        ? String(deviceRecord.device_id)
        : null;

      if (!storedDeviceId || storedDeviceId !== deviceId) {
        return res.status(409).json({
          success: false,
          message:
            "This account is already logged in on another device. Please log out from the other device first.",
        });
      }
    }

    /*
     * Store or update the device for this specific merchant
     * user account.
     */
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

    if (!business) {
      return res.status(404).json({
        success: false,
        message:
          "Merchant business details were not found. Please contact support.",
      });
    }

    if (!process.env.ACCESS_TOKEN_SECRET) {
      throw new Error("ACCESS_TOKEN_SECRET is not configured");
    }

    if (!process.env.REFRESH_TOKEN_SECRET) {
      throw new Error("REFRESH_TOKEN_SECRET is not configured");
    }

    const tokenPayload = {
      user_id: Number(user.user_id),
      role: user.role,
      user_name: user.user_name,
      phone: user.phone,
    };

    const accessToken = jwt.sign(
      tokenPayload,
      process.env.ACCESS_TOKEN_SECRET,
      {
        expiresIn: "60m",
      },
    );

    const refreshToken = jwt.sign(
      tokenPayload,
      process.env.REFRESH_TOKEN_SECRET,
      {
        expiresIn: "1440m",
      },
    );

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token: {
        access_token: accessToken,
        access_token_time: 60,
        refresh_token: refreshToken,
        refresh_token_time: 1440,
      },
      user: {
        user_id: Number(user.user_id),
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
        device_id: deviceId,

        owner_type: business.owner_type ?? null,

        business_id: business.business_id ? Number(business.business_id) : null,

        business_name: business.business_name ?? null,

        business_logo: business.business_logo ?? null,

        address: business.address ?? null,
      },
    });
  } catch (error) {
    console.error("Merchant login error:", {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Login failed due to a server error. Please try again later.",
    });
  }
}

/* ---------------- owners list ---------------- */

function parseOwnersQuery(req) {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || "50", 10), 1),
    200,
  );
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  return { q, limit, offset };
}

// async function listFoodOwners(req, res) {
//   try {
//     const { q, limit, offset } = parseOwnersQuery(req);
//     const whereCondition = {};
//     if (q) {
//       whereCondition.OR = [
//         { business_name: { contains: q, mode: "insensitive" } },
//         { users: { user_name: { contains: q, mode: "insensitive" } } },
//       ];
//     }

//     const businesses = await prisma.merchant_business_details.findMany({
//       where: { owner_type: "food", ...whereCondition },
//       include: {
//         users: { select: { user_id: true, user_name: true, email: true, phone: true, profile_image: true } },
//         merchant_business_types: { include: { business_types: { select: { id: true, name: true } } } },
//       },
//       orderBy: { created_at: "desc" },
//       skip: offset,
//       take: limit,
//     });

//     const businessIds = businesses.map(b => b.business_id);
//     const ratings = await prisma.food_ratings.groupBy({
//       by: ["business_id"],
//       where: { business_id: { in: businessIds } },
//       _avg: { rating: true },
//       _count: { rating: true },
//     });

//     const ratingsMap = new Map();
//     for (const rating of ratings) {
//       ratingsMap.set(rating.business_id, {
//         avg_rating: rating._avg.rating || 0,
//         total_comments: rating._count.rating || 0,
//       });
//     }

//     const data = businesses.map(b => ({
//       business_id: Number(b.business_id),
//       owner_type: b.owner_type,
//       business_name: b.business_name,
//       business_license_number: b.business_license_number,
//       license_image: b.license_image,
//       latitude: b.latitude,
//       longitude: b.longitude,
//       address: b.address,
//       business_logo: b.business_logo,
//       delivery_option: b.delivery_option,
//       min_amount_for_fd: b.min_amount_for_fd,
//       special_celebration: b.special_celebration,
//       special_celebration_discount_percentage: b.special_celebration_discount_percentage,
//       opening_time: b.opening_time,
//       closing_time: b.closing_time,
//       holidays: b.holidays,
//       complement: b.complementary,
//       complement_details: b.complementary_details,
//       created_at: b.created_at,
//       updated_at: b.updated_at,
//       user: {
//         user_id: Number(b.users.user_id),
//         user_name: b.users.user_name,
//         email: b.users.email,
//         phone: b.users.phone,
//         profile_image: b.users.profile_image || null,
//       },
//       business_types: b.merchant_business_types.map(mbt => ({
//         business_type_id: Number(mbt.business_types.id),
//         name: mbt.business_types.name,
//       })),
//       avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
//       total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
//     }));

//     return res.status(200).json({ success: true, kind: "food", count: data.length, data });
//   } catch (err) {
//     console.error("listFoodOwners error:", err);
//     return res.status(500).json({ success: false, message: "Failed to fetch food owners." });
//   }
// }

// Add this at the top of the file to test
let requestCount = 0;

async function listFoodOwners(req, res) {
  const startTime = Date.now();
  requestCount++;
  const requestNumber = requestCount;

  try {
    const { q, limit, offset } = parseOwnersQuery(req);

    // Generate unique cache key
    const cacheKey = `food_owners:q:${q || "none"}:limit:${limit}:offset:${offset}`;

    console.log(`\n📊 Request #${requestNumber} - ${new Date().toISOString()}`);
    console.log(`🔍 Cache Key: ${cacheKey}`);

    // 🔍 TRY TO GET FROM CACHE FIRST
    const cachedData = await cache.get(cacheKey);

    if (cachedData) {
      const responseTime = Date.now() - startTime;
      console.log(`✅ CACHE HIT! Response time: ${responseTime}ms 🚀`);

      return res.status(200).json({
        success: true,
        kind: "food",
        count: cachedData.count,
        data: cachedData.data,
        fromCache: true,
        responseTimeMs: responseTime,
        requestNumber: requestNumber,
      });
    }

    console.log(`❌ CACHE MISS! Fetching from database...`);
    const dbStartTime = Date.now();

    // 📊 FETCH FROM DATABASE
    const whereCondition = {};
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "food", ...whereCondition },
      include: {
        users: {
          select: {
            user_id: true,
            user_name: true,
            email: true,
            phone: true,
            profile_image: true,
          },
        },
        merchant_business_types: {
          include: { business_types: { select: { id: true, name: true } } },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const businessIds = businesses.map((b) => b.business_id);
    const ratings = await prisma.food_ratings.groupBy({
      by: ["business_id"],
      where: { business_id: { in: businessIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingsMap = new Map();
    for (const rating of ratings) {
      ratingsMap.set(rating.business_id, {
        avg_rating: rating._avg.rating || 0,
        total_comments: rating._count.rating || 0,
      });
    }

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      owner_type: b.owner_type,
      business_name: b.business_name,
      business_license_number: b.business_license_number,
      license_image: b.license_image,
      latitude: b.latitude,
      longitude: b.longitude,
      address: b.address,
      business_logo: b.business_logo,
      delivery_option: b.delivery_option,
      min_amount_for_fd: b.min_amount_for_fd,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      opening_time: b.opening_time,
      closing_time: b.closing_time,
      holidays: b.holidays,
      complement: b.complementary,
      complement_details: b.complementary_details,
      created_at: b.created_at,
      updated_at: b.updated_at,
      user: {
        user_id: Number(b.users.user_id),
        user_name: b.users.user_name,
        email: b.users.email,
        phone: b.users.phone,
        profile_image: b.users.profile_image || null,
      },
      business_types: b.merchant_business_types.map((mbt) => ({
        business_type_id: Number(mbt.business_types.id),
        name: mbt.business_types.name,
      })),
      avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
      total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
    }));

    const dbTime = Date.now() - dbStartTime;
    console.log(`📊 Database query took: ${dbTime}ms`);

    // 💾 STORE IN CACHE (5 minutes TTL)
    const responseData = {
      count: data.length,
      data: data,
    };

    await cache.set(cacheKey, responseData, 300);

    const totalTime = Date.now() - startTime;
    console.log(`💾 Cached for next request. Total time: ${totalTime}ms`);

    return res.status(200).json({
      success: true,
      kind: "food",
      count: data.length,
      data: data,
      fromCache: false,
      dbTimeMs: dbTime,
      totalTimeMs: totalTime,
      requestNumber: requestNumber,
    });
  } catch (err) {
    console.error("listFoodOwners error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch food owners.",
      error: err.message,
    });
  }
}
async function listMartOwners(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {};
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "mart", ...whereCondition },
      include: {
        users: {
          select: {
            user_id: true,
            user_name: true,
            email: true,
            phone: true,
            profile_image: true,
          },
        },
        merchant_business_types: {
          include: { business_types: { select: { id: true, name: true } } },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const businessIds = businesses.map((b) => b.business_id);
    const ratings = await prisma.mart_ratings.groupBy({
      by: ["business_id"],
      where: { business_id: { in: businessIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingsMap = new Map();
    for (const rating of ratings) {
      ratingsMap.set(rating.business_id, {
        avg_rating: rating._avg.rating || 0,
        total_comments: rating._count.rating || 0,
      });
    }

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      owner_type: b.owner_type,
      business_name: b.business_name,
      business_license_number: b.business_license_number,
      license_image: b.license_image,
      latitude: b.latitude,
      longitude: b.longitude,
      address: b.address,
      business_logo: b.business_logo,
      delivery_option: b.delivery_option,
      min_amount_for_fd: b.min_amount_for_fd,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      opening_time: b.opening_time,
      closing_time: b.closing_time,
      holidays: b.holidays,
      complement: b.complementary,
      complement_details: b.complementary_details,
      created_at: b.created_at,
      updated_at: b.updated_at,
      user: {
        user_id: Number(b.users.user_id),
        user_name: b.users.user_name,
        email: b.users.email,
        phone: b.users.phone,
        profile_image: b.users.profile_image || null,
      },
      business_types: b.merchant_business_types.map((mbt) => ({
        business_type_id: Number(mbt.business_types.id),
        name: mbt.business_types.name,
      })),
      avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
      total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "mart", count: data.length, data });
  } catch (err) {
    console.error("listMartOwners error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch mart owners." });
  }
}

async function listFoodOwnersWithCelebration(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {
      special_celebration_discount_percentage: { not: null },
    };
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "food", ...whereCondition },
      include: {
        users: { select: { user_id: true, user_name: true, phone: true } },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      business_name: b.business_name,
      business_logo: b.business_logo,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      address: b.address,
      phone: b.users?.phone || null,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "food", count: data.length, data });
  } catch (err) {
    console.error("listFoodOwnersWithCelebration error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch food owners." });
  }
}

async function listMartOwnersWithCelebration(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {
      special_celebration_discount_percentage: { not: null },
    };
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "mart", ...whereCondition },
      include: {
        users: { select: { user_id: true, user_name: true, phone: true } },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      business_name: b.business_name,
      business_logo: b.business_logo,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      address: b.address,
      phone: b.users?.phone || null,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "mart", count: data.length, data });
  } catch (err) {
    console.error("listMartOwnersWithCelebration error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch mart owners." });
  }
}

module.exports = {
  registerMerchant,
  updateMerchant,
  loginByEmail,
  listFoodOwners,
  listMartOwners,
  listFoodOwnersWithCelebration,
  listMartOwnersWithCelebration,
};
