const { prisma } = require("../lib/prisma");
const bcrypt = require("bcryptjs");

/* =========================================================
   HELPERS
========================================================= */

function toIdArray(input) {
  if (input == null) return [];

  const parts = Array.isArray(input) ? input : String(input).split(",");

  const output = [];

  for (const part of parts) {
    const value = Number(String(part).trim());

    if (Number.isInteger(value) && value > 0 && !output.includes(value)) {
      output.push(value);
    }
  }

  return output;
}

function normalizeEmail(value) {
  if (value === null || value === undefined) return null;

  const normalized = String(value).trim().toLowerCase();

  return normalized || null;
}

function normalizePhone(value) {
  if (value === null || value === undefined) return null;

  let normalized = String(value)
    .trim()
    .replace(/[^\d+]/g, "");

  if (!normalized) return null;

  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  }

  if (normalized.startsWith("+975")) {
    return normalized;
  }

  if (normalized.startsWith("975")) {
    return `+${normalized}`;
  }

  if (normalized.startsWith("+")) {
    return normalized;
  }

  return `+975${normalized}`;
}

function normalizeRole(value, defaultRole = "merchant") {
  const normalized =
    value !== null && value !== undefined
      ? String(value).trim().toLowerCase()
      : "";

  return normalized || defaultRole;
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";

  return String(value).trim();
}

function getPrismaConstraintTarget(error) {
  const target = error?.meta?.target;

  if (Array.isArray(target)) {
    return target.map((item) => String(item).toLowerCase()).join(",");
  }

  if (target !== null && target !== undefined) {
    return String(target).toLowerCase();
  }

  return "";
}

async function mapTypeNamesToIds(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return [];
  }

  const normalizedNames = names
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);

  if (normalizedNames.length === 0) {
    return [];
  }

  const businessTypes = await prisma.business_types.findMany({
    select: {
      id: true,
      name: true,
    },
  });

  return businessTypes
    .filter((businessType) =>
      normalizedNames.includes(
        String(businessType.name || "")
          .trim()
          .toLowerCase(),
      ),
    )
    .map((businessType) => Number(businessType.id));
}

async function filterValidTypeIds(typeIds) {
  if (!Array.isArray(typeIds) || typeIds.length === 0) {
    return [];
  }

  const numericIds = typeIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const validTypes = await prisma.business_types.findMany({
    where: {
      id: {
        in: numericIds,
      },
    },
    select: {
      id: true,
    },
  });

  const validIdSet = new Set(validTypes.map((type) => Number(type.id)));

  return numericIds.filter((id) => validIdSet.has(id));
}

async function checkScopedUsernameExists(userName, role, ownerType) {
  const normalizedUserName = normalizeText(userName);
  const normalizedRole = normalizeRole(role);
  const normalizedOwnerType = normalizeText(ownerType).toLowerCase();

  if (!normalizedUserName || !normalizedRole || !normalizedOwnerType) {
    return false;
  }

  const users = await prisma.users.findMany({
    where: {
      user_name: normalizedUserName,
      role: normalizedRole,
    },
    include: {
      merchant_business_details: {
        select: {
          owner_type: true,
        },
      },
    },
  });

  return users.some((user) => {
    const sameUsername =
      String(user.user_name || "")
        .trim()
        .toLowerCase() === normalizedUserName.toLowerCase();

    if (!sameUsername) return false;

    return user.merchant_business_details.some(
      (business) =>
        String(business.owner_type || "")
          .trim()
          .toLowerCase() === normalizedOwnerType,
    );
  });
}

/* =========================================================
   REGISTER MERCHANT
========================================================= */

async function registerMerchantModel(data) {
  const {
    user_name,
    email,
    phone,
    cid,
    password,
    business_name,
    business_type_ids,
    business_types,
    business_license_number,
    license_image,
    latitude,
    longitude,
    address,
    business_logo,
    delivery_option,
    owner_type,
    min_amount_for_fd,
    bank_name,
    account_holder_name,
    account_number,
    bank_qr_code_image,
    special_celebration,
    special_celebration_discount_percentage,
  } = data;

  /* =========================================================
     NORMALIZATION
  ========================================================= */

  const normalizedUserName = normalizeText(user_name);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedRole = normalizeRole(data.role, "merchant");
  const normalizedOwnerType = normalizeText(owner_type).toLowerCase();
  const normalizedCid = normalizeText(cid);

  const normalizedPassword =
    password !== null && password !== undefined ? String(password) : "";

  const normalizedBusinessName = normalizeText(business_name);
  const normalizedBankName = normalizeText(bank_name);
  const normalizedAccountHolderName = normalizeText(account_holder_name);
  const normalizedAccountNumber = normalizeText(account_number);

  /* =========================================================
     VALIDATION
  ========================================================= */

  if (!normalizedUserName) {
    throw new Error("user_name is required");
  }

  if (!normalizedEmail) {
    throw new Error("email is required");
  }

  if (!normalizedPhone) {
    throw new Error("phone is required");
  }

  if (!normalizedCid) {
    throw new Error("cid is required for merchants");
  }

  if (!/^\d{11}$/.test(normalizedCid)) {
    throw new Error("cid must contain exactly 11 digits");
  }

  if (!normalizedPassword) {
    throw new Error("password is required");
  }

  if (normalizedPassword.length < 6) {
    throw new Error("password must contain at least 6 characters");
  }

  if (!normalizedBusinessName) {
    throw new Error("business_name is required");
  }

  if (!normalizedOwnerType) {
    throw new Error("owner_type is required");
  }

  if (!normalizedBankName) {
    throw new Error("bank_name is required");
  }

  if (!normalizedAccountHolderName) {
    throw new Error("account_holder_name is required");
  }

  if (!normalizedAccountNumber) {
    throw new Error("account_number is required");
  }

  if (normalizedRole !== "merchant") {
    throw new Error(
      "Invalid role. Merchant registration requires the merchant role.",
    );
  }

  /* =========================================================
     BUSINESS TYPES
  ========================================================= */

  let incomingTypeIds = toIdArray(business_type_ids);

  if (
    incomingTypeIds.length === 0 &&
    Array.isArray(business_types) &&
    business_types.length > 0
  ) {
    const mappedTypeIds = await mapTypeNamesToIds(business_types);

    incomingTypeIds = toIdArray(mappedTypeIds);
  }

  if (incomingTypeIds.length === 0) {
    throw new Error("At least one business type is required.");
  }

  const validTypeIds = await filterValidTypeIds(incomingTypeIds);

  if (validTypeIds.length !== incomingTypeIds.length) {
    const invalidIds = incomingTypeIds.filter(
      (id) => !validTypeIds.includes(Number(id)),
    );

    throw new Error(
      `Invalid business_type_ids: ${invalidIds.join(
        ", ",
      )}. These IDs do not exist.`,
    );
  }

  /* =========================================================
     DUPLICATE CHECKS
  ========================================================= */

  /*
   * Phone is unique by phone + role.
   */
  const existingPhoneRole = await prisma.users.findFirst({
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

  if (existingPhoneRole) {
    throw new Error(
      "This phone number is already registered for the merchant role. Please login instead.",
    );
  }

  /*
   * Email is unique by email + role.
   */
  const existingEmailRole = await prisma.users.findFirst({
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

  if (existingEmailRole) {
    throw new Error(
      "This email address is already registered for the merchant role. Please login instead.",
    );
  }

  /*
   * CID is unique by CID + role.
   *
   * Important:
   * Use existingCidRole consistently.
   * Do not use the old variable name existingCid.
   */
  const existingCidRole = await prisma.users.findFirst({
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

  if (existingCidRole) {
    throw new Error(
      "This CID number is already registered for the merchant role. Please login instead.",
    );
  }

  const usernameExists = await checkScopedUsernameExists(
    normalizedUserName,
    normalizedRole,
    normalizedOwnerType,
  );

  if (usernameExists) {
    throw new Error(
      "Username already exists for this owner type. Choose another username or change owner_type.",
    );
  }

  /* =========================================================
     NUMERIC VALIDATION
  ========================================================= */

  const minimumFreeDeliveryAmount =
    min_amount_for_fd !== undefined &&
    min_amount_for_fd !== null &&
    min_amount_for_fd !== ""
      ? Number(min_amount_for_fd)
      : 0;

  if (
    !Number.isFinite(minimumFreeDeliveryAmount) ||
    minimumFreeDeliveryAmount < 0
  ) {
    throw new Error("min_amount_for_fd must be a valid non-negative number");
  }

  const parsedLatitude =
    latitude === null || latitude === undefined || latitude === ""
      ? null
      : Number(latitude);

  const parsedLongitude =
    longitude === null || longitude === undefined || longitude === ""
      ? null
      : Number(longitude);

  if (parsedLatitude !== null && !Number.isFinite(parsedLatitude)) {
    throw new Error("Invalid latitude");
  }

  if (parsedLongitude !== null && !Number.isFinite(parsedLongitude)) {
    throw new Error("Invalid longitude");
  }

  /* =========================================================
     TRANSACTION
  ========================================================= */

  return prisma.$transaction(async (tx) => {
    const passwordHash = await bcrypt.hash(normalizedPassword, 10);

    let newUser;

    try {
      newUser = await tx.users.create({
        data: {
          user_name: normalizedUserName,
          email: normalizedEmail,
          phone: normalizedPhone,
          cid: normalizedCid,
          password_hash: passwordHash,
          role: normalizedRole,
          is_active: true,
          is_verified: false,
        },
      });
    } catch (error) {
      if (error?.code === "P2002") {
        const target = getPrismaConstraintTarget(error);

        const duplicatePhoneRole =
          target.includes("users_phone_role_unique") ||
          (target.includes("phone") && target.includes("role"));

        const duplicateEmailRole =
          target.includes("users_email_role_unique") ||
          (target.includes("email") && target.includes("role"));

        const duplicateCidRole =
          target.includes("users_cid_role_unique") ||
          (target.includes("cid") && target.includes("role"));

        if (duplicatePhoneRole) {
          throw new Error(
            "This phone number is already registered for the merchant role. Please login instead.",
          );
        }

        if (duplicateEmailRole) {
          throw new Error(
            "This email address is already registered for the merchant role. Please login instead.",
          );
        }

        if (duplicateCidRole) {
          throw new Error(
            "This CID number is already registered for the merchant role. Please login instead.",
          );
        }

        throw new Error(
          "A merchant account already exists with the provided information.",
        );
      }

      throw error;
    }

    const userId = newUser.user_id;

    const newBusiness = await tx.merchant_business_details.create({
      data: {
        user_id: userId,
        business_name: normalizedBusinessName,

        business_license_number: business_license_number
          ? normalizeText(business_license_number)
          : null,

        license_image: license_image || null,
        latitude: parsedLatitude,
        longitude: parsedLongitude,

        address: address ? normalizeText(address) : null,

        business_logo: business_logo || null,
        delivery_option: delivery_option || "SELF",
        owner_type: normalizedOwnerType,
        min_amount_for_fd: minimumFreeDeliveryAmount,

        special_celebration: special_celebration || null,

        special_celebration_discount_percentage:
          special_celebration_discount_percentage !== undefined &&
          special_celebration_discount_percentage !== null &&
          special_celebration_discount_percentage !== ""
            ? Number(special_celebration_discount_percentage)
            : null,
      },
    });

    const businessId = newBusiness.business_id;

    for (const typeId of validTypeIds) {
      await tx.merchant_business_types.create({
        data: {
          business_id: businessId,
          business_type_id: typeId,
        },
      });
    }

    await tx.merchant_bank_details.create({
      data: {
        user_id: userId,
        bank_name: normalizedBankName,
        account_holder_name: normalizedAccountHolderName,
        account_number: normalizedAccountNumber,
        bank_qr_code_image: bank_qr_code_image || null,
      },
    });

    return {
      user_id: Number(userId),
      business_id: Number(businessId),
      business_type_ids: validTypeIds.map((id) => Number(id)),
    };
  });
}

/* =========================================================
   UPDATE MERCHANT BUSINESS
========================================================= */

async function updateMerchantDetailsModel(businessId, data) {
  return prisma.$transaction(async (tx) => {
    const existingBusiness = await tx.merchant_business_details.findUnique({
      where: {
        business_id: businessId,
      },
    });

    if (!existingBusiness) {
      throw new Error("Business not found");
    }

    const updateData = {};

    const setIfProvided = (column, value, transform = (item) => item) => {
      if (value !== undefined) {
        updateData[column] = transform(value);
      }
    };

    const toDateTime = (timeString) => {
      if (!timeString) return null;

      const [hours, minutes, seconds = "00"] = String(timeString).split(":");

      const date = new Date();

      date.setHours(Number(hours));
      date.setMinutes(Number(minutes));
      date.setSeconds(Number(seconds));
      date.setMilliseconds(0);

      return date;
    };

    setIfProvided("business_name", data.business_name);

    setIfProvided("business_license_number", data.business_license_number);

    setIfProvided("license_image", data.license_image);

    setIfProvided("latitude", data.latitude, (value) =>
      value === "" || value === null ? null : Number(value),
    );

    setIfProvided("longitude", data.longitude, (value) =>
      value === "" || value === null ? null : Number(value),
    );

    setIfProvided("address", data.address);

    setIfProvided("business_logo", data.business_logo);

    setIfProvided("delivery_option", data.delivery_option);

    setIfProvided("owner_type", data.owner_type, (value) =>
      value ? String(value).trim().toLowerCase() : undefined,
    );

    setIfProvided("opening_time", data.opening_time, toDateTime);

    setIfProvided("closing_time", data.closing_time, toDateTime);

    setIfProvided(
      "kitchen_closing_time",
      data.kitchen_closing_time,
      toDateTime,
    );

    setIfProvided("special_celebration", data.special_celebration);

    setIfProvided(
      "special_celebration_discount_percentage",
      data.special_celebration_discount_percentage,
    );

    setIfProvided("min_amount_for_fd", data.min_amount_for_fd, (value) => {
      if (value === "" || value == null) {
        return 0;
      }

      const numberValue = Number(value);

      if (!Number.isFinite(numberValue) || numberValue < 0) {
        throw new Error("Invalid min_amount_for_fd");
      }

      return numberValue;
    });

    if (data.holidays !== undefined) {
      let holidays = [];

      if (Array.isArray(data.holidays)) {
        holidays = data.holidays;
      } else if (typeof data.holidays === "string") {
        holidays = data.holidays
          .split(",")
          .map((day) => day.trim())
          .filter(Boolean);
      }

      updateData.holidays = JSON.stringify(holidays);
    }

    if (Object.keys(updateData).length > 0) {
      updateData.updated_at = new Date();

      await tx.merchant_business_details.update({
        where: {
          business_id: businessId,
        },
        data: updateData,
      });
    }

    let incomingTypeIds = toIdArray(data.business_type_ids);

    if (
      incomingTypeIds.length === 0 &&
      Array.isArray(data.business_types) &&
      data.business_types.length > 0
    ) {
      const mappedIds = await mapTypeNamesToIds(data.business_types);

      incomingTypeIds = toIdArray(mappedIds);
    }

    if (
      data.business_type_ids !== undefined ||
      data.business_types !== undefined
    ) {
      const validIds = await filterValidTypeIds(incomingTypeIds);

      if (
        validIds.length !== incomingTypeIds.length &&
        incomingTypeIds.length > 0
      ) {
        const invalidIds = incomingTypeIds.filter(
          (id) => !validIds.includes(Number(id)),
        );

        throw new Error(
          `Invalid business_type_ids: ${invalidIds.join(
            ", ",
          )}. These IDs do not exist.`,
        );
      }

      await tx.merchant_business_types.deleteMany({
        where: {
          business_id: businessId,
        },
      });

      for (const typeId of validIds) {
        await tx.merchant_business_types.create({
          data: {
            business_id: businessId,
            business_type_id: typeId,
          },
        });
      }
    }

    return {
      business_id: Number(businessId),
    };
  });
}

/* =========================================================
   LOGIN FINDER
========================================================= */

async function findCandidatesByEmail(email) {
  const normalizedEmail =
    email !== null && email !== undefined
      ? String(email).trim().toLowerCase()
      : "";

  if (!normalizedEmail) {
    return [];
  }

  return prisma.users.findMany({
    where: {
      email: normalizedEmail,
      role: "merchant",
    },
    orderBy: {
      user_id: "desc",
    },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      phone: true,
      role: true,
      password_hash: true,
      is_active: true,
      is_verified: true,
    },
  });
}

module.exports = {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByEmail,
};
