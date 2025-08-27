const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findUserByUsername,
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
  try {
    const f = req.files || {};
    const b = req.body || {};

    const license_image = f.license_image?.[0]
      ? toRelPath(f.license_image[0])
      : fromBodyToStoredPath(b.license_image);
    const business_logo = f.business_logo?.[0]
      ? toRelPath(f.business_logo[0])
      : fromBodyToStoredPath(b.business_logo);
    const bank_card_front_image = f.bank_card_front_image?.[0]
      ? toRelPath(f.bank_card_front_image[0])
      : fromBodyToStoredPath(b.bank_card_front_image);
    const bank_card_back_image = f.bank_card_back_image?.[0]
      ? toRelPath(f.bank_card_back_image[0])
      : fromBodyToStoredPath(b.bank_card_back_image);
    const bank_qr_code_image = f.bank_qr_code_image?.[0]
      ? toRelPath(f.bank_qr_code_image[0])
      : fromBodyToStoredPath(b.bank_qr_code_image);

    const payload = {
      // users
      user_name: b.user_name,
      email: b.email,
      phone: b.phone,
      password: b.password,
      role: "merchant",

      // business
      business_name: b.business_name,
      business_type_ids: b.business_type_ids ?? null,
      business_types: Array.isArray(b.business_types)
        ? b.business_types
        : typeof b.business_types === "string" && b.business_types.trim()
        ? b.business_types
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
      business_license_number: b.business_license_number,
      license_image,
      latitude:
        b.latitude !== undefined &&
        b.latitude !== "" &&
        !isNaN(Number(b.latitude))
          ? Number(b.latitude)
          : null,
      longitude:
        b.longitude !== undefined &&
        b.longitude !== "" &&
        !isNaN(Number(b.longitude))
          ? Number(b.longitude)
          : null,
      address: b.address || null,
      business_logo,
      delivery_option: b.delivery_option,
      owner_type: b.owner_type || "individual",

      // bank
      bank_name: b.bank_name,
      account_holder_name: b.account_holder_name,
      account_number: b.account_number,
      bank_card_front_image,
      bank_card_back_image,
      bank_qr_code_image,
    };

    const result = await registerMerchantModel(payload);
    res.status(201).json({
      message: "Merchant registered successfully",
      user_id: result.user_id,
      business_id: result.business_id,
      business_type_ids: result.business_type_ids,
    });
  } catch (err) {
    console.error(err.message || err);
    const isClientErr = /exists|required|invalid/i.test(err.message || "");
    res
      .status(isClientErr ? 400 : 500)
      .json({ error: err.message || "Merchant registration failed" });
  }
}

/* ---------------- update business details ---------------- */

async function updateMerchant(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    if (!Number.isInteger(business_id) || business_id <= 0) {
      return res.status(400).json({ error: "Invalid businessId" });
    }

    const [rows] = await db.query(
      `SELECT license_image, business_logo FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
      [business_id]
    );
    if (!rows.length)
      return res.status(404).json({ error: "Business not found" });
    const oldLicense = rows[0].license_image || null;
    const oldLogo = rows[0].business_logo || null;

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
    ].forEach((k) => {
      if (b[k] !== undefined) updatePayload[k] = b[k];
    });

    if (b.license_image !== undefined || f.license_image?.length) {
      updatePayload.license_image = newLicenseImage;
    }
    if (b.business_logo !== undefined || f.business_logo?.length) {
      updatePayload.business_logo = newBusinessLogo;
    }
    if (b.latitude !== undefined) {
      updatePayload.latitude = b.latitude === "" ? null : Number(b.latitude);
    }
    if (b.longitude !== undefined) {
      updatePayload.longitude = b.longitude === "" ? null : Number(b.longitude);
    }
    if (b.holidays !== undefined) {
      updatePayload.holidays = Array.isArray(b.holidays)
        ? b.holidays
        : String(b.holidays);
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

    const out = await updateMerchantDetailsModel(business_id, updatePayload);

    // delete replaced images
    const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
    const isUploadsPath = (p) =>
      typeof p === "string" && /^\/?uploads\//i.test(p.replace(/^\/+/, ""));
    const toAbsPath = (webPath) =>
      path.join(process.cwd(), webPath.replace(/^\//, ""));

    const deleteIfReplaced = (oldPath, newPath) => {
      if (!oldPath || !newPath) return;
      const oldNorm = String(oldPath).trim();
      const newNorm = String(newPath).trim();
      if (!oldNorm || !isUploadsPath(oldNorm) || oldNorm === newNorm) return;
      const abs = toAbsPath(oldNorm);
      if (!abs.startsWith(UPLOAD_ROOT)) return;
      fs.stat(abs, (err, st) => {
        if (err || !st?.isFile()) return;
        fs.unlink(abs, () => {});
      });
    };

    if (updatePayload.license_image)
      deleteIfReplaced(oldLicense, updatePayload.license_image);
    if (updatePayload.business_logo)
      deleteIfReplaced(oldLogo, updatePayload.business_logo);

    return res.status(200).json({
      message: "Business details updated",
      business_id: out.business_id,
    });
  } catch (err) {
    console.error("updateMerchant error:", err);
    const isClientErr = /not found|invalid/i.test(err.message || "");
    return res
      .status(isClientErr ? 404 : 500)
      .json({ error: err.message || "Update failed" });
  }
}

/* ---------------- login ---------------- */

async function loginByUsername(req, res) {
  try {
    const { user_name, password } = req.body || {};
    if (!user_name || !password) {
      return res
        .status(400)
        .json({ error: "user_name and password are required" });
    }

    const user = await findUserByUsername(user_name);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.is_active !== undefined && Number(user.is_active) === 0) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact support." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    const [[biz]] = await db.query(
      `SELECT business_id, business_name, owner_type, business_logo, address
         FROM merchant_business_details
        WHERE user_id = ? 
        ORDER BY created_at DESC, business_id DESC
        LIMIT 1`,
      [user.user_id]
    );

    const payload = {
      user_id: user.user_id,
      role: user.role,
      user_name: user.user_name,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "1m",
    });
    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "10m",
    });

    return res.status(200).json({
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 1,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        owner_type: biz?.owner_type ?? null,
        business_id: biz?.business_id ?? null,
        business_name: biz?.business_name ?? null,
        business_logo: biz?.business_logo ?? null,
        address: biz?.address ?? null,
      },
    });
  } catch (err) {
    console.error("loginByUsername error:", err);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
}

/* ---------------- NEW: owners list (food/mart) ---------------- */

async function listOwnersByKind(req, res, kind) {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200
    );
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const params = [kind];
    let whereSearch = "";
    if (q) {
      whereSearch = ` AND (LOWER(mbd.business_name) LIKE ? OR LOWER(u.user_name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit, offset);

    const [rows] = await db.query(
      `
      SELECT
        mbd.business_id,
        mbd.business_name,
        mbd.owner_type,
        mbd.business_logo,
        mbd.address,
        mbd.latitude,
        mbd.longitude,
        u.user_id,
        u.user_name,
        u.email,
        u.phone,
        u.profile_image,
        mbd.complementary AS complement,
        mbd.complementary_details AS complement_details,
        COALESCE(ROUND(AVG(fmr.rating), 2), 0) AS avg_rating,
        COUNT(fmr.comment) AS total_comments,
        GROUP_CONCAT(DISTINCT bt.name) AS tags
      FROM merchant_business_details mbd
      JOIN merchant_business_types mbt
        ON mbt.business_id = mbd.business_id
      JOIN business_types bt
        ON bt.id = mbt.business_type_id
      JOIN users u
        ON u.user_id = mbd.user_id
      LEFT JOIN food_menu fmn
        ON fmn.business_id = mbd.business_id
      LEFT JOIN food_menu_ratings fmr
        ON fmr.menu_id = fmn.id
      WHERE LOWER(bt.types) = ?
      ${whereSearch}
      GROUP BY mbd.business_id
      ORDER BY mbd.created_at DESC, mbd.business_id DESC
      LIMIT ? OFFSET ?
      `,
      params
    );

    return res.status(200).json({
      success: true,
      kind,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error(`listOwnersByKind(${kind}) error:`, err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch owners." });
  }
}

const listFoodOwners = (req, res) => listOwnersByKind(req, res, "food");
const listMartOwners = (req, res) => listOwnersByKind(req, res, "mart");

module.exports = {
  registerMerchant,
  updateMerchant,
  loginByUsername,
  listFoodOwners,
  listMartOwners,
};
