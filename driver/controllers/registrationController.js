const { prisma } = require("../lib/prisma.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

/* ===================== REGISTER ===================== */

const registerUser = async (req, res) => {
  let user_id = null;
  let driver_id = null;

  // --- helpers ---
  const normalizeBhutanPhone = (raw) => {
    if (raw == null) return null;

    // keep + and digits only
    let s = String(raw)
      .trim()
      .replace(/[^\d+]/g, "");

    // Convert 00-prefixed to +
    if (s.startsWith("00")) s = `+${s.slice(2)}`;

    // If already has +975, keep it
    if (s.startsWith("+975")) return s;

    // If starts with 975 (no +), add +
    if (s.startsWith("975")) return `+${s}`;

    // If starts with + (other country), keep as-is (or enforce +975 if you want)
    if (s.startsWith("+")) return s;

    // Otherwise prepend +975
    return `+975${s}`;
  };

  try {
    const { user, driver, documents, vehicle } = req.body;

    if (!user || !user.password || !user.role) {
      return res.status(400).json({ error: "Missing required user fields" });
    }

    // ✅ Normalize phone: ensure it has +975 prefix (unless already +something)
    const normalizedPhone = normalizeBhutanPhone(user.phone);

    // deviceID may come from driver.device_id or req.body.deviceID
    const deviceID = driver?.device_id ?? req.body.deviceID ?? null;

    // ✅ Require device ID for everyone EXCEPT admins
    const requiresDevice = user?.role !== "admin";
    if (requiresDevice && !deviceID) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    // Start transaction
    const result = await prisma.$transaction(async (prismaTx) => {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      // 1) Create user
      const newUser = await prismaTx.users.create({
        data: {
          user_name: user.user_name ?? null,
          email: user.email ? user.email.toLowerCase() : null, // Store email in lowercase
          phone: normalizedPhone,
          password_hash: hashedPassword,
          is_verified: 1,
          role: user.role,
        },
      });
      user_id = newUser.user_id;

      // 2) device (skip for admin)
      if (requiresDevice) {
        const deviceTable =
          user.role === "driver" ? "driver_devices" : "user_devices";

        if (user.role === "driver") {
          await prismaTx.driver_devices.create({
            data: {
              user_id: user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        } else {
          await prismaTx.user_devices.create({
            data: {
              user_id: user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        }
      }

      // 3) driver-only inserts
      if (user.role === "driver") {
        if (
          !driver ||
          !driver.current_location?.coordinates ||
          !driver.license_number ||
          !driver.license_expiry
        ) {
          throw new Error("Missing required driver fields");
        }
        if (!vehicle || !vehicle.capacity || !vehicle.vehicle_type) {
          throw new Error("Missing required vehicle fields");
        }

        const lng = driver.current_location.coordinates[0];
        const lat = driver.current_location.coordinates[1];

        // Create driver
        const newDriver = await prismaTx.drivers.create({
          data: {
            user_id: user_id,
            license_number: driver.license_number,
            license_expiry: new Date(driver.license_expiry),
            approval_status: "pending",
            is_approved: 0,
            rating: 0,
            total_rides: 0,
            is_online: 0,
            current_location: `POINT(${lng} ${lat})`,
            current_location_updated_at: new Date(),
          },
        });
        driver_id = newDriver.driver_id;

        // documents
        if (Array.isArray(documents) && documents.length > 0) {
          for (const doc of documents) {
            await prismaTx.driver_documents.create({
              data: {
                driver_id: driver_id,
                document_type: doc.document_type,
                document_url: doc.document_url,
              },
            });
          }
        }

        // vehicle
        if (vehicle) {
          await prismaTx.driver_vehicles.create({
            data: {
              driver_id: driver_id,
              make: vehicle.make ?? null,
              model: vehicle.model ?? null,
              year: vehicle.year ?? null,
              color: vehicle.color ?? null,
              license_plate: vehicle.license_plate ?? null,
              vehicle_type: vehicle.vehicle_type,
              actual_capacity: vehicle.capacity,
              available_capacity: vehicle.capacity,
              features: Array.isArray(vehicle.features)
                ? vehicle.features.join(",")
                : null,
              insurance_expiry: vehicle.insurance_expiry
                ? new Date(vehicle.insurance_expiry)
                : null,
              code: vehicle.code ?? null,
            },
          });
        }
      }

      return { newUser: newUser };
    });

    return res.status(201).json({
      message:
        user.role === "driver"
          ? "User and driver registered successfully"
          : user.role === "admin"
            ? "Admin registered successfully"
            : "User registered successfully",
      user_id,
      phone: normalizedPhone,
    });
  } catch (err) {
    console.error("Registration error:", err);
    let errorMessage = "Registration failed";

    // Handle Prisma unique constraint errors
    if (err.code === "P2002") {
      const target = err.meta?.target;
      if (Array.isArray(target)) {
        if (target.includes("email")) {
          errorMessage = "Email already exists";
        } else if (target.includes("phone")) {
          errorMessage = "Phone number already exists";
        } else if (target.includes("license_number")) {
          errorMessage = "Driver license number already exists";
        } else if (target.includes("license_plate")) {
          errorMessage = "Vehicle license plate already exists";
        } else {
          errorMessage = `Duplicate entry for ${target.join(", ")}`;
        }
      } else {
        errorMessage = "Duplicate entry";
      }

      // Clean up user if created (Prisma transaction auto-rolls back, but we need to handle manual cleanup if needed)
      return res.status(409).json({ error: errorMessage });
    }

    return res.status(500).json({
      error: err.sqlMessage || err.message || errorMessage,
    });
  }
};

/* ===================== LOGIN (sets is_verified=1) ===================== */

const loginUser = async (req, res) => {
  // --- helpers ---
  const normalizeBhutanPhone = (raw) => {
    if (raw == null) return null;

    let s = String(raw)
      .trim()
      .replace(/[^\d+]/g, "");
    if (!s) return null;

    if (s.startsWith("00")) s = `+${s.slice(2)}`;
    if (s.startsWith("+975")) return s;
    if (s.startsWith("975")) return `+${s}`;
    if (s.startsWith("+")) return s; // keep other country codes as-is
    return `+975${s}`;
  };

  const normalizeEmail = (raw) => {
    if (raw == null) return null;
    const e = String(raw).trim().toLowerCase();
    return e ? e : null;
  };

  const safeDeviceId = (raw) => {
    const v = raw == null ? "" : String(raw).trim();
    return v ? v : null;
  };

  const truthy = (v) => {
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "y";
  };

  const isAdminRole = (role) => {
    const r = String(role || "")
      .toLowerCase()
      .trim();
    return (
      r === "admin" ||
      r === "super admin" ||
      r === "super_admin" ||
      r === "superadmin"
    );
  };

  try {
    const b = req.body || {};

    const phone = b.phone ? normalizeBhutanPhone(b.phone) : null;
    const email = b.email ? normalizeEmail(b.email) : null;

    const password = b.password != null ? String(b.password) : null;
    if (!password) {
      return res
        .status(400)
        .json({ success: false, message: "Password is required" });
    }

    if (!phone && !email) {
      return res.status(400).json({
        success: false,
        message: "Phone or email is required",
      });
    }

    const desktop = truthy(b.desktop);
    const deviceId = safeDeviceId(
      b.device_id ?? b.deviceID ?? b.deviceId ?? b.deviceid ?? null,
    );

    // 1) Fetch candidates (email case-insensitive OR exact phone)
    let candidates = [];

    if (email) {
      // ✅ FIXED: Use raw query for case-insensitive email search
      const normalizedEmail = email.toLowerCase();
      candidates = await prisma.$queryRaw`
        SELECT user_id, user_name, phone, email, role, is_active, is_verified, password_hash
        FROM users
        WHERE LOWER(email) = ${normalizedEmail}
        ORDER BY user_id DESC
        LIMIT 25
      `;
    } else {
      candidates = await prisma.users.findMany({
        where: { phone: phone },
        select: {
          user_id: true,
          user_name: true,
          phone: true,
          email: true,
          role: true,
          is_active: true,
          is_verified: true,
          password_hash: true,
        },
        orderBy: { user_id: "desc" },
        take: 25,
      });
    }

    if (!candidates.length) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // 2) Compare password against candidates (newest first)
    let picked = null;
    for (const u of candidates) {
      if (!u?.password_hash) continue;
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) {
        picked = u;
        break;
      }
    }

    if (!picked) {
      return res
        .status(401)
        .json({ success: false, message: "Incorrect password" });
    }

    // 3) Fetch fresh user row
    const user = await prisma.users.findUnique({
      where: { user_id: picked.user_id },
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

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (Number(user.is_active) === 0) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated. Please contact support.",
      });
    }

    const roleLower = String(user.role || "")
      .toLowerCase()
      .trim();
    const isMerchant = roleLower === "merchant";
    const adminNoDevice = isAdminRole(user.role);

    // ✅ NEW: Merchant desktop login -> no device id required
    // Device rules:
    // - Admin/Super Admin: NO device id required, NO device lock
    // - Merchant with desktop=true: NO device id required, NO device lock
    // - Others: device id REQUIRED
    const merchantDesktopNoDevice = isMerchant && desktop === true;

    if (!adminNoDevice && !merchantDesktopNoDevice && !deviceId) {
      return res.status(400).json({
        success: false,
        message: "device_id is required",
      });
    }

    // 5) If already verified, enforce same-device lock
    // (NOT for admin/super admin and NOT for merchant desktop=true)
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      Number(user.is_verified) === 1
    ) {
      const deviceRecord = await prisma.all_device_ids.findUnique({
        where: { user_id: user.user_id },
        select: { device_id: true },
      });

      const dbDeviceId = deviceRecord?.device_id
        ? String(deviceRecord.device_id)
        : null;

      if (!dbDeviceId || dbDeviceId !== deviceId) {
        return res.status(409).json({
          success: false,
          message:
            "This account appears to be logged in on another device. Please log out from the other device and then try logging in again.",
        });
      }
    }

    // 6) Save/REPLACE device id
    // (NOT for admin/super admin and NOT for merchant desktop=true)
    if (!adminNoDevice && !merchantDesktopNoDevice && deviceId) {
      try {
        await prisma.all_device_ids.upsert({
          where: { user_id: user.user_id },
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
      } catch (e) {
        console.error("device_id save failed:", e?.message || e);
      }
    }

    // 7) Normalize stored phone (optional, only if login was by phone and differs)
    if (phone && user.phone && user.phone !== phone) {
      try {
        await prisma.users.update({
          where: { user_id: user.user_id },
          data: { phone: phone },
        });
        user.phone = phone;
      } catch (e) {
        console.error("phone normalize update failed:", e?.message || e);
      }
    }

    // 8) Mark verified + last_login (always on successful login)
    try {
      await prisma.users.update({
        where: { user_id: user.user_id },
        data: {
          is_verified: 1,
          last_login: new Date(),
        },
      });
      user.is_verified = 1;
    } catch (e) {
      console.error("is_verified update failed:", e?.message || e);
    }

    // 9) Merchant extras (only for merchant)
    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (isMerchant) {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: { user_id: user.user_id },
          orderBy: { created_at: "desc", business_id: "desc" },
          select: {
            business_id: true,
            business_name: true,
            owner_type: true,
            business_logo: true,
            address: true,
          },
        });

        owner_type = business?.owner_type ?? null;
        business_id = business?.business_id ?? null;
        business_name = business?.business_name ?? null;
        business_logo = business?.business_logo ?? null;
        address = business?.address ?? null;
      } catch (e) {
        console.error("merchant extras fetch failed:", e?.message || e);
      }
    }

    // 10) Issue tokens
    const payload = {
      user_id: user.user_id,
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

    // 11) Response shape
    if (isMerchant) {
      return res.status(200).json({
        message: "Login successful",
        token: {
          access_token,
          access_token_time: 60,
          refresh_token,
          refresh_token_time: 1440,
        },
        user: {
          user_id: user.user_id,
          user_name: user.user_name,
          phone: user.phone,
          role: user.role,
          email: user.email,
          is_verified: 1,
          device_id: adminNoDevice || merchantDesktopNoDevice ? null : deviceId,
          owner_type,
          business_id,
          business_name,
          business_logo,
          address,
        },
      });
    }

    return res.status(200).json({
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 1440,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
      },
    });
  } catch (err) {
    console.error("loginUser error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Login failed due to server error" });
  }
};

/* ===================== LOGOUT (sets is_verified=0) ===================== */
/**
 * POST /api/auth/logout
 * Accepts either:
 *  - Authorization via x-access-token (preferred), or
 *  - { user_id } in body (fallback when no auth middleware present)
 */

const logoutUser = async (req, res) => {
  try {
    console.log(
      "➡️ logout hit",
      req.method,
      req.originalUrl,
      req.params,
      new Date().toISOString(),
    );

    const { user_id } = req.params; // expects /logout/:user_id
    const n = Number(user_id);

    if (!Number.isInteger(n) || n <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid or missing user_id param" });
    }

    // ✅ Update user using Prisma
    const result = await prisma.users.update({
      where: { user_id: n },
      data: {
        is_verified: 0,
        last_login: new Date(),
      },
    });

    if (!result) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({
      message: "Logout successful",
      user_id: n,
      is_verified: 0,
    });
  } catch (err) {
    console.error("Logout error:", err);
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    return res.status(500).json({ error: "Logout failed due to server error" });
  }
};

/* ===================== VERIFY ACTIVE SESSION ===================== */

const verifyActiveSession = async (req, res) => {
  const { user_id, device_id } = req.body || {};

  const uid = Number(user_id);
  const deviceId =
    device_id && String(device_id).trim() ? String(device_id).trim() : null;

  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user_id" });
  }

  if (!deviceId) {
    return res
      .status(400)
      .json({ success: false, message: "device_id is required" });
  }

  try {
    // 1) Check user + is_verified
    const user = await prisma.users.findUnique({
      where: { user_id: uid },
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

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // If inactive -> force is_verified=0
    if (Number(user.is_active) !== 1) {
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: 0, last_login: new Date() },
      });
      return res
        .status(403)
        .json({ success: false, message: "Account is deactivated." });
    }

    // If already not verified -> keep it 0
    if (Number(user.is_verified) !== 1) {
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: 0, last_login: new Date() },
      });
      return res.status(200).json({ success: false });
    }

    // 2) Check device match in all_device_ids
    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: { user_id: uid },
      select: { device_id: true },
    });

    const dbDeviceId = deviceRecord?.device_id
      ? String(deviceRecord.device_id)
      : null;

    if (!dbDeviceId || dbDeviceId !== deviceId) {
      // ✅ If mismatch -> force logout (is_verified=0)
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: 0, last_login: new Date() },
      });
      return res.status(200).json({ success: false });
    }

    // 3) Merchant extras
    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (user.role === "merchant") {
      const business = await prisma.merchant_business_details.findFirst({
        where: { user_id: uid },
        orderBy: { created_at: "desc", business_id: "desc" },
        select: {
          owner_type: true,
          business_id: true,
          business_name: true,
          business_logo: true,
          address: true,
        },
      });

      if (business) {
        owner_type = business.owner_type ?? null;
        business_id = business.business_id ?? null;
        business_name = business.business_name ?? null;
        business_logo = business.business_logo ?? null;
        address = business.address ?? null;
      }
    }

    // 4) Issue tokens
    const payload = {
      user_id: user.user_id,
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });

    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "1440m",
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
        device_id: deviceId,
        ...(user.role === "merchant"
          ? { owner_type, business_id, business_name, business_logo, address }
          : {}),
      },
    });
  } catch (err) {
    console.error("verifyActiveSession error:", err);
    // optional: don't force is_verified=0 on server errors
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* ===================== REFRESH ACCESS TOKEN ===================== */
/**
 * POST /api/auth/refresh-token
 * Body: { refresh_token }  (or Authorization: Bearer <refresh_token> as fallback)
 *
 * - Verifies refresh token using REFRESH_TOKEN_SECRET
 * - Optional: checks user's is_active and is_verified
 * - Optional: checks device_id matches stored device (if you want strict binding)
 * - Returns a NEW access_token (and optionally a new refresh_token if you want rotation)
 */
const refreshAccessToken = async (req, res) => {
  try {
    const bodyToken = req.body?.refresh_token;

    // Optional fallback: allow refresh token in Authorization header
    const auth = req.headers.authorization || "";
    const headerToken = auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : null;

    const refreshToken = bodyToken || headerToken;

    if (!refreshToken) {
      return res
        .status(400)
        .json({ success: false, message: "refresh_token is required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (e) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired refresh token" });
    }

    const uid = Number(decoded?.user_id);
    if (!Number.isInteger(uid) || uid <= 0) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
    }

    // ✅ Load user (and validate)
    const user = await prisma.users.findUnique({
      where: { user_id: uid },
      select: {
        user_id: true,
        role: true,
        phone: true,
        is_active: true,
        is_verified: true,
      },
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (Number(user.is_active) !== 1) {
      return res
        .status(403)
        .json({ success: false, message: "Account is deactivated." });
    }

    // ✅ Optional: require active verified session to refresh
    // If you want refresh to work even when is_verified=0, remove this block.
    if (Number(user.is_verified) !== 1 && user.role !== "admin") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    // ✅ Optional strict device binding (uncomment if you want)
    // const deviceId = req.body?.device_id ? String(req.body.device_id).trim() : null;
    // if (!deviceId && user.role !== "admin") {
    //   return res.status(400).json({ success: false, message: "device_id is required" });
    // }
    // if (deviceId && user.role !== "admin") {
    //   const deviceRecord = await prisma.all_device_ids.findUnique({
    //     where: { user_id: uid },
    //     select: { device_id: true },
    //   });
    //   const dbDeviceId = deviceRecord?.device_id ? String(deviceRecord.device_id) : null;
    //   if (!dbDeviceId || dbDeviceId !== deviceId) {
    //     await prisma.users.update({
    //       where: { user_id: uid },
    //       data: { is_verified: 0, last_login: new Date() },
    //     });
    //     return res.status(401).json({ success: false, message: "Device mismatch. Please login again." });
    //   }
    // }

    // ✅ Issue new access token (keep payload minimal)
    const payload = {
      user_id: user.user_id,
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });

    // ✅ Optional rotation: also return a new refresh token
    // If you rotate, consider storing/blacklisting old refresh tokens.
    // const new_refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: "10m" });

    return res.status(200).json({
      success: true,
      message: "Token refreshed",
      token: {
        access_token,
        access_token_time: 60,
        // refresh_token: new_refresh_token,
        // refresh_token_time: 10,
      },
    });
  } catch (err) {
    console.error("refreshAccessToken error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  registerUser,
  loginUser, // now sets is_verified=1 + updates last_login
  logoutUser, // sets is_verified=0
  verifyActiveSession,
  refreshAccessToken,
};
