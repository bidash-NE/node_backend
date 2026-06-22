const { prisma } = require("../lib/prisma.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

/* =========================================================
   COMMON HELPERS
========================================================= */

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return value;
}

function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}

function normalizeBhutanPhone(raw) {
  if (raw === null || raw === undefined) return null;

  let phone = String(raw)
    .trim()
    .replace(/[^\d+]/g, "");

  if (!phone) return null;

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
}

function normalizeEmail(raw) {
  if (raw === null || raw === undefined) return null;

  const email = String(raw).trim().toLowerCase();

  return email || null;
}

function normalizeRole(raw) {
  if (raw === null || raw === undefined) return null;

  const role = String(raw).trim().toLowerCase();

  return role || null;
}

function safeDeviceId(raw) {
  if (raw === null || raw === undefined) return null;

  const deviceId = String(raw).trim();

  return deviceId || null;
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

function isAdminRole(role) {
  const normalizedRole = normalizeRole(role);

  return (
    normalizedRole === "admin" ||
    normalizedRole === "super admin" ||
    normalizedRole === "super_admin" ||
    normalizedRole === "superadmin" ||
    normalizedRole === "finance"
  );
}

/*
 * Phone numbers such as App Store review accounts can skip
 * the single-device restriction.
 */
const DEMO_BYPASS_PHONES = ["+97517368132"];

function isDemoBypassPhone(phone) {
  return Boolean(phone) && DEMO_BYPASS_PHONES.includes(phone);
}

/*
 * Prisma P2002 target can be returned as:
 *
 * ["phone", "role"]
 * "users_phone_role_unique"
 * "phone"
 *
 * This helper converts the target into a searchable string.
 */
function getPrismaConstraintTarget(error) {
  const target = error?.meta?.target;

  if (Array.isArray(target)) {
    return target.map(String).join(",").toLowerCase();
  }

  if (target !== null && target !== undefined) {
    return String(target).toLowerCase();
  }

  return "";
}

/* =========================================================
   REGISTER USER
========================================================= */

const registerUser = async (req, res) => {
  let userId = null;
  let driverId = null;

  try {
    const body = req.body || {};
    const user = body.user || null;
    const driver = body.driver || null;
    const documents = body.documents || null;
    const vehicle = body.vehicle || null;

    if (!user) {
      return errorResponse(
        res,
        400,
        "Please provide the required user information.",
      );
    }

    const normalizedPhone = normalizeBhutanPhone(user.phone);
    const normalizedEmail = normalizeEmail(user.email);
    const normalizedRole = normalizeRole(user.role);

    const normalizedCid =
      user.cid !== null &&
      user.cid !== undefined &&
      String(user.cid).trim() !== ""
        ? String(user.cid).trim()
        : null;

    const userName =
      user.user_name !== null && user.user_name !== undefined
        ? String(user.user_name).trim()
        : "";

    const password =
      user.password !== null && user.password !== undefined
        ? String(user.password)
        : "";

    /* =========================================================
       BASIC VALIDATION
    ========================================================= */

    if (!userName) {
      return errorResponse(res, 400, "User name is required.");
    }

    if (!normalizedPhone) {
      return errorResponse(res, 400, "Phone number is required.");
    }

    if (!normalizedEmail) {
      return errorResponse(res, 400, "Email address is required.");
    }

    if (!password) {
      return errorResponse(res, 400, "Password is required.");
    }

    if (!normalizedRole) {
      return errorResponse(res, 400, "User role is required.");
    }

    if (password.length < 6) {
      return errorResponse(
        res,
        400,
        "Password must contain at least 6 characters.",
      );
    }

    /*
     * CID remains optional for roles that do not require it.
     * When supplied, it must contain exactly 11 digits.
     */
    if (normalizedCid && !/^\d{11}$/.test(normalizedCid)) {
      return errorResponse(res, 400, "CID must contain exactly 11 digits.");
    }

    const deviceID = safeDeviceId(
      driver?.device_id ??
        body.device_id ??
        body.deviceID ??
        body.deviceId ??
        null,
    );

    /*
     * Admin, finance and organizer accounts do not require
     * a registered mobile device during registration.
     */
    const requiresDevice =
      normalizedRole !== "admin" &&
      normalizedRole !== "finance" &&
      normalizedRole !== "organizer";

    if (requiresDevice && !deviceID) {
      return errorResponse(res, 400, "Device ID is required for registration.");
    }

    /* =========================================================
       DRIVER VALIDATION
    ========================================================= */

    if (normalizedRole === "driver") {
      const coordinates = driver?.current_location?.coordinates;

      if (
        !driver ||
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        !driver.license_number ||
        !driver.license_expiry
      ) {
        return errorResponse(
          res,
          400,
          "Please provide all required driver information, including license and location.",
        );
      }

      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);

      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return errorResponse(
          res,
          400,
          "Driver location coordinates are invalid.",
        );
      }

      const licenseExpiry = new Date(driver.license_expiry);

      if (Number.isNaN(licenseExpiry.getTime())) {
        return errorResponse(
          res,
          400,
          "Driver license expiry date is invalid.",
        );
      }

      if (!vehicle || !vehicle.capacity || !vehicle.vehicle_type) {
        return errorResponse(
          res,
          400,
          "Please provide all required vehicle information.",
        );
      }

      const vehicleCapacity = Number(vehicle.capacity);

      if (!Number.isFinite(vehicleCapacity) || vehicleCapacity <= 0) {
        return errorResponse(
          res,
          400,
          "Vehicle capacity must be greater than zero.",
        );
      }
    }

    /* =========================================================
       DATABASE TRANSACTION
    ========================================================= */

    await prisma.$transaction(async (prismaTx) => {
      /*
       * Phone is unique by phone + role.
       */
      const existingPhoneRoleAccount = await prismaTx.users.findFirst({
        where: {
          phone: normalizedPhone,
          role: normalizedRole,
        },
        select: {
          user_id: true,
          phone: true,
          role: true,
        },
      });

      if (existingPhoneRoleAccount) {
        const duplicateError = new Error("phone_role_already_exists");

        duplicateError.registrationRole = normalizedRole;

        throw duplicateError;
      }

      /*
       * Email is unique by email + role.
       *
       * The same email can therefore be used for different roles,
       * but only once within the same role.
       */
      const existingEmailRoleAccount = await prismaTx.users.findFirst({
        where: {
          email: normalizedEmail,
          role: normalizedRole,
        },
        select: {
          user_id: true,
          email: true,
          role: true,
        },
      });

      if (existingEmailRoleAccount) {
        const duplicateEmailError = new Error("email_role_already_exists");

        duplicateEmailError.registrationRole = normalizedRole;

        throw duplicateEmailError;
      }

      /*
       * CID is unique by CID + role.
       *
       * CID is checked only when supplied.
       */
      if (normalizedCid) {
        const existingCidRoleAccount = await prismaTx.users.findFirst({
          where: {
            cid: normalizedCid,
            role: normalizedRole,
          },
          select: {
            user_id: true,
            cid: true,
            role: true,
          },
        });

        if (existingCidRoleAccount) {
          const duplicateCidError = new Error("cid_role_already_exists");

          duplicateCidError.registrationRole = normalizedRole;

          throw duplicateCidError;
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await prismaTx.users.create({
        data: {
          user_name: userName,
          email: normalizedEmail,
          phone: normalizedPhone,
          cid: normalizedCid,
          password_hash: hashedPassword,
          is_verified: false,
          is_active: true,
          role: normalizedRole,
        },
      });

      userId = toNumber(newUser.user_id);

      /* =========================================================
         DEVICE REGISTRATION
      ========================================================= */

      if (requiresDevice) {
        if (normalizedRole === "driver") {
          await prismaTx.driver_devices.create({
            data: {
              user_id: newUser.user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        } else {
          await prismaTx.user_devices.create({
            data: {
              user_id: newUser.user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        }
      }

      /* =========================================================
         DRIVER RECORDS
      ========================================================= */

      if (normalizedRole === "driver") {
        const longitude = Number(driver.current_location.coordinates[0]);

        const latitude = Number(driver.current_location.coordinates[1]);

        const licenseExpiry = new Date(driver.license_expiry);

        const vehicleCapacity = Number(vehicle.capacity);

        await prismaTx.$executeRaw`
          INSERT INTO drivers (
            user_id,
            license_number,
            license_expiry,
            approval_status,
            is_approved,
            rating,
            total_rides,
            is_online,
            current_location,
            current_location_updated_at
          )
          VALUES (
            ${newUser.user_id},
            ${String(driver.license_number).trim()},
            ${licenseExpiry},
            'pending',
            0,
            0.00,
            0,
            0,
            ST_GeomFromText(
              ${`POINT(${longitude} ${latitude})`},
              4326
            ),
            NOW()
          )
        `;

        const newDriver = await prismaTx.drivers.findFirst({
          where: {
            user_id: newUser.user_id,
          },
          select: {
            driver_id: true,
          },
          orderBy: {
            driver_id: "desc",
          },
        });

        if (!newDriver) {
          throw new Error("driver_insert_failed");
        }

        driverId = toNumber(newDriver.driver_id);

        if (Array.isArray(documents) && documents.length > 0) {
          for (const document of documents) {
            if (!document?.document_type || !document?.document_url) {
              throw new Error("invalid_driver_document");
            }

            await prismaTx.driver_documents.create({
              data: {
                driver_id: newDriver.driver_id,
                document_type: String(document.document_type).trim(),
                document_url: String(document.document_url).trim(),
              },
            });
          }
        }

        await prismaTx.driver_vehicles.create({
          data: {
            driver_id: newDriver.driver_id,

            make: vehicle.make ? String(vehicle.make).trim() : null,

            model: vehicle.model ? String(vehicle.model).trim() : null,

            year:
              vehicle.year !== null && vehicle.year !== undefined
                ? Number(vehicle.year)
                : null,

            color: vehicle.color ? String(vehicle.color).trim() : null,

            license_plate: vehicle.license_plate
              ? String(vehicle.license_plate).trim()
              : null,

            vehicle_type: String(vehicle.vehicle_type).trim(),

            actual_capacity: vehicleCapacity,
            available_capacity: vehicleCapacity,

            features: (() => {
              const features = vehicle.features;

              if (features === null || features === undefined) {
                return null;
              }

              if (Array.isArray(features)) {
                return features.join(",");
              }

              if (typeof features === "object") {
                return Object.values(features).join(",");
              }

              return String(features);
            })(),

            insurance_expiry: vehicle.insurance_expiry
              ? new Date(vehicle.insurance_expiry)
              : null,

            code: vehicle.code ? String(vehicle.code).trim() : null,
          },
        });
      }
    });

    /* =========================================================
       SUCCESS RESPONSE
    ========================================================= */

    let message = "Registration successful.";

    if (normalizedRole === "driver") {
      message =
        "Driver registration successful. Your registration is pending approval.";
    } else if (normalizedRole === "admin") {
      message = "Admin registration successful.";
    } else if (normalizedRole === "finance") {
      message = "Finance registration successful.";
    } else if (normalizedRole === "merchant") {
      message = "Merchant registration successful.";
    } else if (normalizedRole === "organizer") {
      message = "Organizer registration successful.";
    }

    return res.status(201).json({
      success: true,
      message,
      user_id: userId,
      driver_id: driverId,
      phone: normalizedPhone,
      email: normalizedEmail,
      cid: normalizedCid,
      role: normalizedRole,
    });
  } catch (err) {
    console.error("Registration error:", err?.message || err);

    console.error("Registration error code:", err?.code || null);

    console.error("Registration error metadata:", err?.meta || null);

    /* =========================================================
       EXPLICIT DUPLICATE CHECK RESPONSES
    ========================================================= */

    if (err?.message === "phone_role_already_exists") {
      return errorResponse(
        res,
        409,
        `This phone number is already registered for the ${
          err.registrationRole || "selected"
        } role. Please login instead.`,
      );
    }

    if (err?.message === "email_role_already_exists") {
      return errorResponse(
        res,
        409,
        `This email address is already registered for the ${
          err.registrationRole || "selected"
        } role. Please login instead.`,
      );
    }

    if (err?.message === "cid_role_already_exists") {
      return errorResponse(
        res,
        409,
        `This CID number is already registered for the ${
          err.registrationRole || "selected"
        } role. Please login instead.`,
      );
    }

    /* =========================================================
       PRISMA UNIQUE CONSTRAINT RESPONSES
    ========================================================= */

    if (err?.code === "P2002") {
      const target = getPrismaConstraintTarget(err);

      const requestedRole = normalizeRole(req.body?.user?.role) || "selected";

      const isPhoneRoleConstraint =
        target.includes("users_phone_role_unique") ||
        (target.includes("phone") && target.includes("role"));

      const isEmailRoleConstraint =
        target.includes("users_email_role_unique") ||
        (target.includes("email") && target.includes("role"));

      const isCidRoleConstraint =
        target.includes("users_cid_role_unique") ||
        (target.includes("cid") && target.includes("role"));

      if (isPhoneRoleConstraint) {
        return errorResponse(
          res,
          409,
          `This phone number is already registered for the ${requestedRole} role. Please login instead.`,
        );
      }

      if (isEmailRoleConstraint) {
        return errorResponse(
          res,
          409,
          `This email address is already registered for the ${requestedRole} role. Please login instead.`,
        );
      }

      if (isCidRoleConstraint) {
        return errorResponse(
          res,
          409,
          `This CID number is already registered for the ${requestedRole} role. Please login instead.`,
        );
      }

      return errorResponse(
        res,
        409,
        "An account already exists with the provided information.",
      );
    }

    if (err?.message === "driver_insert_failed") {
      return errorResponse(
        res,
        500,
        "Failed to create the driver record. Please try again.",
      );
    }

    if (err?.message === "invalid_driver_document") {
      return errorResponse(
        res,
        400,
        "Every driver document must include a document type and document URL.",
      );
    }

    return errorResponse(
      res,
      500,
      "Registration failed. Please try again later.",
    );
  }
};

/* =========================================================
   LOGIN USER
========================================================= */

const loginUser = async (req, res) => {
  try {
    const body = req.body || {};

    const phone = body.phone ? normalizeBhutanPhone(body.phone) : null;

    const email = body.email ? normalizeEmail(body.email) : null;

    const requestedRole = body.role ? normalizeRole(body.role) : null;

    const password =
      body.password !== null && body.password !== undefined
        ? String(body.password)
        : null;

    if (!password) {
      return errorResponse(res, 400, "Password is required.");
    }

    if (!phone && !email) {
      return errorResponse(
        res,
        400,
        "Please provide either an email address or phone number.",
      );
    }

    /*
     * Role should be sent because the same phone can now exist
     * under several roles.
     */
    if (!requestedRole) {
      return errorResponse(res, 400, "Role is required for login.");
    }

    const desktop = truthy(body.desktop);

    const deviceId = safeDeviceId(
      body.device_id ?? body.deviceID ?? body.deviceId ?? body.deviceid ?? null,
    );

    let candidates = [];

    if (email) {
      /*
       * Email remains globally unique, but role is still checked
       * to prevent one application from logging into another role.
       */
      candidates = await prisma.users.findMany({
        where: {
          email,
          role: requestedRole,
        },
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
        orderBy: {
          user_id: "desc",
        },
        take: 5,
      });
    } else {
      candidates = await prisma.users.findMany({
        where: {
          phone,
          role: requestedRole,
        },
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
        orderBy: {
          user_id: "desc",
        },
        take: 5,
      });
    }

    if (!candidates.length) {
      return errorResponse(
        res,
        404,
        `No ${requestedRole} account was found with this ${
          email ? "email address" : "phone number"
        }.`,
      );
    }

    let pickedUser = null;

    for (const candidate of candidates) {
      if (!candidate?.password_hash) continue;

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
      return errorResponse(res, 401, "Incorrect password. Please try again.");
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

    if (!user) {
      return errorResponse(
        res,
        404,
        "Account not found. Please contact support.",
      );
    }

    user.user_id = toNumber(user.user_id);

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    /*
     * Drivers cannot log in until approval_status is approved.
     */
    if (normalizeRole(user.role) === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: {
          user_id: user.user_id,
        },
        select: {
          approval_status: true,
        },
      });

      const approvalStatus =
        normalizeRole(driverRecord?.approval_status) || "pending";

      if (approvalStatus === "pending") {
        return errorResponse(
          res,
          403,
          "Your registration is under review. You will be notified once approved.",
        );
      }

      if (approvalStatus === "rejected") {
        return errorResponse(
          res,
          403,
          "Your registration was not approved. Please contact support.",
        );
      }
    }

    const roleLower = normalizeRole(user.role);
    const isMerchant = roleLower === "merchant";
    const isFinance = roleLower === "finance";
    const adminNoDevice = isAdminRole(user.role);
    const merchantDesktopNoDevice = isMerchant && desktop === true;
    const financeNoDevice = isFinance && desktop === true;

    // Device conflict check - skip for finance, admin, demo/review accounts,
    // and logins that don't supply a device_id (device_id is optional)
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      !isDemoBypassPhone(user.phone) &&
      user.is_verified === true &&
      deviceId
    ) {
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

      if (!databaseDeviceId || databaseDeviceId !== deviceId) {
        return errorResponse(
          res,
          409,
          "You are already logged in on another device. Please log out from that device first.",
        );
      }
    }

    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      deviceId
    ) {
      try {
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
      } catch (deviceError) {
        console.error(
          "Device ID save failed:",
          deviceError?.message || deviceError,
        );
      }
    }

    try {
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
    } catch (updateError) {
      console.error(
        "User login status update failed:",
        updateError?.message || updateError,
      );
    }

    let ownerType = null;
    let businessId = null;
    let businessName = null;
    let businessLogo = null;
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
          ownerType = business.owner_type ?? null;
          businessId = business.business_id
            ? toNumber(business.business_id)
            : null;
          businessName = business.business_name ?? null;
          businessLogo = business.business_logo ?? null;
          address = business.address ?? null;
        }
      } catch (businessError) {
        console.error(
          "Merchant details fetch failed:",
          businessError?.message || businessError,
        );
      }
    }

    const tokenPayload = {
      user_id: toNumber(user.user_id),
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

    const userResponse = {
      user_id: toNumber(user.user_id),
      user_name: user.user_name,
      phone: user.phone,
      role: user.role,
      email: user.email,
      is_verified: user.is_verified ? 1 : 0,
    };

    if (isMerchant) {
      userResponse.owner_type = ownerType;
      userResponse.business_id = businessId;
      userResponse.business_name = businessName;
      userResponse.business_logo = businessLogo;
      userResponse.address = address;
      userResponse.device_id =
        adminNoDevice || merchantDesktopNoDevice ? null : deviceId;
    } else if (isFinance) {
      userResponse.device_id =
        adminNoDevice || financeNoDevice ? null : deviceId;
    } else {
      userResponse.device_id = adminNoDevice ? null : deviceId;
    }

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token: {
        access_token: accessToken,
        access_token_time: 60,
        refresh_token: refreshToken,
        refresh_token_time: 1440,
      },
      user: userResponse,
    });
  } catch (err) {
    console.error("Login error:", err);

    return errorResponse(
      res,
      500,
      "Unable to login at this time. Please try again later.",
    );
  }
};

/* =========================================================
   LOGOUT USER
========================================================= */

const logoutUser = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return errorResponse(res, 400, "Invalid user information.");
    }

    await prisma.users.update({
      where: {
        user_id: userId,
      },
      data: {
        is_verified: false,
        last_login: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      message: "You have been successfully logged out.",
    });
  } catch (err) {
    console.error("Logout error:", err);

    if (err?.code === "P2025") {
      return errorResponse(res, 404, "Account not found.");
    }

    return errorResponse(
      res,
      500,
      "Unable to logout at this time. Please try again later.",
    );
  }
};

/* =========================================================
   VERIFY ACTIVE SESSION
========================================================= */

const verifyActiveSession = async (req, res) => {
  const body = req.body || {};
  const userId = Number(body.user_id);
  const deviceId = safeDeviceId(body.device_id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return errorResponse(res, 400, "Invalid user information.");
  }

  if (!deviceId) {
    return errorResponse(res, 400, "Device information is required.");
  }

  try {
    const user = await prisma.users.findUnique({
      where: {
        user_id: userId,
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

    if (!user) {
      return errorResponse(res, 404, "Account not found.");
    }

    if (user.is_active === false) {
      await prisma.users.update({
        where: {
          user_id: userId,
        },
        data: {
          is_verified: false,
          last_login: new Date(),
        },
      });

      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    if (user.is_verified === false) {
      return res.status(200).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    if (normalizeRole(user.role) === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: {
          user_id: userId,
        },
        select: {
          approval_status: true,
        },
      });

      const approvalStatus =
        normalizeRole(driverRecord?.approval_status) || "pending";

      if (approvalStatus === "pending") {
        return res.status(200).json({
          success: false,
          message:
            "Your registration is under review. You will be notified once approved.",
          approval_status: "pending",
        });
      }

      if (approvalStatus === "rejected") {
        return res.status(200).json({
          success: false,
          message:
            "Your registration was not approved. Please contact support.",
          approval_status: "rejected",
        });
      }
    }

    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: {
        user_id: userId,
      },
      select: {
        device_id: true,
      },
    });

    const databaseDeviceId = deviceRecord?.device_id
      ? String(deviceRecord.device_id)
      : null;

    if (!databaseDeviceId || databaseDeviceId !== deviceId) {
      await prisma.users.update({
        where: {
          user_id: userId,
        },
        data: {
          is_verified: false,
          last_login: new Date(),
        },
      });

      return res.status(200).json({
        success: false,
        message: "Session expired due to a device change. Please login again.",
      });
    }

    let ownerType = null;
    let businessId = null;
    let businessName = null;
    let businessLogo = null;
    let address = null;

    if (normalizeRole(user.role) === "merchant") {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: {
            user_id: userId,
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
            owner_type: true,
            business_id: true,
            business_name: true,
            business_logo: true,
            address: true,
          },
        });

        if (business) {
          ownerType = business.owner_type ?? null;
          businessId = business.business_id
            ? toNumber(business.business_id)
            : null;
          businessName = business.business_name ?? null;
          businessLogo = business.business_logo ?? null;
          address = business.address ?? null;
        }
      } catch (businessError) {
        console.error(
          "Merchant details fetch failed:",
          businessError?.message || businessError,
        );
      }
    }

    const tokenPayload = {
      user_id: toNumber(user.user_id),
      role: user.role,
      phone: String(user.phone || ""),
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

    const userResponse = {
      user_id: toNumber(user.user_id),
      user_name: user.user_name,
      phone: user.phone,
      role: user.role,
      email: user.email,
      is_verified: 1,
      device_id: deviceId,
    };

    if (normalizeRole(user.role) === "merchant") {
      userResponse.owner_type = ownerType;
      userResponse.business_id = businessId;
      userResponse.business_name = businessName;
      userResponse.business_logo = businessLogo;
      userResponse.address = address;
    }

    return res.status(200).json({
      success: true,
      message: "Session verified successfully.",
      token: {
        access_token: accessToken,
        access_token_time: 60,
        refresh_token: refreshToken,
        refresh_token_time: 1440,
      },
      user: userResponse,
    });
  } catch (err) {
    console.error("Verify active session error:", err);

    return errorResponse(
      res,
      500,
      "Unable to verify the session. Please try again later.",
    );
  }
};

/* =========================================================
   REFRESH ACCESS TOKEN
========================================================= */

const refreshAccessToken = async (req, res) => {
  try {
    const bodyToken = req.body?.refresh_token;
    const authorizationHeader = req.headers.authorization || "";

    const headerToken = authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length).trim()
      : null;

    const refreshToken = bodyToken || headerToken;

    if (!refreshToken) {
      return errorResponse(res, 400, "Refresh token is required.");
    }

    let decodedToken;

    try {
      decodedToken = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (_verificationError) {
      return errorResponse(
        res,
        401,
        "Your session has expired. Please login again.",
      );
    }

    const userId = Number(decodedToken?.user_id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return errorResponse(
        res,
        401,
        "Invalid session information. Please login again.",
      );
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: userId,
      },
      select: {
        user_id: true,
        role: true,
        phone: true,
        is_active: true,
        is_verified: true,
      },
    });

    if (!user) {
      return errorResponse(res, 404, "Account not found.");
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    const tokenPayload = {
      user_id: toNumber(user.user_id),
      role: user.role,
      phone: user.phone,
    };

    const accessToken = jwt.sign(
      tokenPayload,
      process.env.ACCESS_TOKEN_SECRET,
      {
        expiresIn: "60m",
      },
    );

    return res.status(200).json({
      success: true,
      message: "Token refreshed successfully.",
      token: {
        access_token: accessToken,
        access_token_time: 60,
        refresh_token: refreshToken,
        refresh_token_time: 1440,
      },
    });
  } catch (err) {
    console.error("Refresh access token error:", err);

    return errorResponse(
      res,
      500,
      "Unable to refresh the session. Please login again.",
    );
  }
};

module.exports = {
  registerUser,
  loginUser,
  logoutUser,
  verifyActiveSession,
  refreshAccessToken,
};
