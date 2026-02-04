// controllers/merchantRegistrationController.js
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByEmail, // email-based finder
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

    const bank_qr_code_image = f.bank_qr_code_image?.[0]
      ? toRelPath(f.bank_qr_code_image[0])
      : fromBodyToStoredPath(b.bank_qr_code_image);

    const payload = {
      // users
      user_name: b.user_name,
      email: b.email,
      phone: b.phone,
      cid: b.cid,
      password: b.password,
      role: (b.role || "merchant").toLowerCase(),

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
      owner_type: (b.owner_type || "individual").toLowerCase(),

      // 🔹 free-delivery threshold (per merchant)
      // missing / "" => 0 (feature off)
      min_amount_for_fd:
        b.min_amount_for_fd !== undefined && b.min_amount_for_fd !== ""
          ? Number(b.min_amount_for_fd)
          : 0,

      // Bank
      bank_name: b.bank_name,
      account_holder_name: b.account_holder_name,
      account_number: b.account_number,
      bank_qr_code_image,

      // special celebration and discount
      special_celebration: b.special_celebration || null, // Handling the new field
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage || null, // Handling the new field
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
    const isClientErr = /exists|required|invalid|username/i.test(
      err.message || "",
    );
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
      [business_id],
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
      "special_celebration", // Include special_celebration in the update payload
      "special_celebration_discount_percentage", // Include special_celebration_discount_percentage in the update payload
    ].forEach((k) => {
      if (b[k] !== undefined)
        updatePayload[k] =
          k === "owner_type" ? String(b[k]).toLowerCase() : b[k];
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

    // 🔹 allow merchant to update min_amount_for_fd
    // empty string => 0 (feature off)
    if (typeof b.min_amount_for_fd !== "undefined") {
      const raw = String(b.min_amount_for_fd).trim();
      updatePayload.min_amount_for_fd = raw === "" ? 0 : Number(raw);
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

/* ---------------- login (email + password ONLY) ---------------- */

async function loginByEmail(req, res) {
  try {
    const { email, password, device_id } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    // ✅ device_id OPTIONAL (save only if provided)
    const deviceId =
      device_id && String(device_id).trim() ? String(device_id).trim() : null;

    // 1) Fetch by email (case-insensitive)
    const candidates = await findCandidatesByEmail(email); // newest first
    if (!candidates.length) {
      return res.status(404).json({ error: "User not found" });
    }

    // 2) Compare password
    const matched = [];
    for (const u of candidates) {
      if (!u?.password_hash) continue;
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) matched.push(u);
    }

    if (!matched.length) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    matched.sort((a, b) => b.user_id - a.user_id);
    const user = matched[0];

    if (Number(user.is_active) === 0) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact support." });
    }

    // ✅ Save device_id for notifications (ONLY if provided)
    if (deviceId) {
      try {
        await db.query(
          `INSERT INTO all_device_ids (user_id, device_id, last_seen)
           VALUES (?, ?, NOW())
           ON DUPLICATE KEY UPDATE last_seen = NOW()`,
          [user.user_id, deviceId],
        );
      } catch (e) {
        console.error("device_id save failed:", e?.message || e);
      }
    }

    /* -----------------------------------------------------------
       Mark as verified on successful login (idempotent)
    ----------------------------------------------------------- */
    try {
      await db.query(
        `UPDATE users
            SET is_verified = 1,
                last_login = NOW()
          WHERE user_id = ?`,
        [user.user_id],
      );
    } catch (e) {
      console.error("is_verified update failed:", e?.message || e);
    }

    // Pull latest business attached to this user
    const [[biz]] = await db.query(
      `SELECT business_id, business_name, owner_type, business_logo, address
         FROM merchant_business_details
        WHERE user_id = ?
        ORDER BY created_at DESC, business_id DESC
        LIMIT 1`,
      [user.user_id],
    );

    const payload = {
      user_id: user.user_id,
      role: user.role,
      user_name: user.user_name,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });
    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "10m",
    });

    return res.status(200).json({
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
        ...(deviceId ? { device_id: deviceId } : {}),
        owner_type: biz?.owner_type ?? null,
        business_id: biz?.business_id ?? null,
        business_name: biz?.business_name ?? null,
        business_logo: biz?.business_logo ?? null,
        address: biz?.address ?? null,
      },
    });
  } catch (err) {
    console.error("loginByEmail error:", err);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
}

/* ---------------- owners list (split by vertical) ---------------- */

function parseOwnersQuery(req) {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || "50", 10), 1),
    200,
  );
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  return { q, limit, offset };
}

async function listFoodOwners(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);

    const params = [];
    let whereSearch = "";
    if (q) {
      whereSearch = ` AND (LOWER(mbd.business_name) LIKE ? OR LOWER(u.user_name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit, offset);

    // Ratings now come from food_ratings with business_id
    const [rows] = await db.query(
      `SELECT
         mbd.business_id,
         MAX(mbd.business_name) AS business_name,
         MAX(mbd.owner_type) AS owner_type,
         MAX(mbd.business_logo) AS business_logo,
         MAX(mbd.address) AS address,
         MAX(mbd.latitude) AS latitude,
         MAX(mbd.longitude) AS longitude,
         MAX(mbd.opening_time) AS opening_time,
         MAX(mbd.closing_time) AS closing_time,
         MAX(mbd.min_amount_for_fd) AS min_amount_for_fd,
         MAX(u.user_id) AS user_id,
         MAX(u.user_name) AS user_name,
         MAX(u.email) AS email,
         MAX(u.phone) AS phone,
         MAX(u.profile_image) AS profile_image,
         MAX(mbd.complementary) AS complement,
         MAX(mbd.complementary_details) AS complement_details,
         COALESCE(ROUND(AVG(fr.rating), 2), 0) AS avg_rating,
         SUM(CASE WHEN fr.comment IS NOT NULL AND fr.comment <> '' THEN 1 ELSE 0 END) AS total_comments,
         GROUP_CONCAT(DISTINCT bt.name) AS tags,
         MAX(mbd.special_celebration_discount_percentage) AS special_celebration_discount_percentage,
         MAX(mbd.special_celebration) AS special_celebration -- Added special_celebration
      FROM merchant_business_details mbd
      JOIN users u ON u.user_id = mbd.user_id
      LEFT JOIN merchant_business_types mbt ON mbt.business_id = mbd.business_id
      LEFT JOIN business_types bt ON bt.id = mbt.business_type_id
      LEFT JOIN food_ratings fr ON fr.business_id = mbd.business_id
      WHERE TRIM(LOWER(mbd.owner_type)) = 'food'
      ${whereSearch}
      GROUP BY mbd.business_id
      ORDER BY MAX(mbd.created_at) DESC, mbd.business_id DESC
      LIMIT ? OFFSET ?`,
      params,
    );

    return res.status(200).json({
      success: true,
      kind: "food",
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("listFoodOwners error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch food owners." });
  }
}

async function listMartOwners(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);

    const params = [];
    let whereSearch = "";
    if (q) {
      whereSearch = ` AND (LOWER(mbd.business_name) LIKE ? OR LOWER(u.user_name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit, offset);

    // Ratings now come from mart_ratings with business_id
    const [rows] = await db.query(
      `SELECT
         mbd.business_id,
         MAX(mbd.business_name) AS business_name,
         MAX(mbd.owner_type) AS owner_type,
         MAX(mbd.business_logo) AS business_logo,
         MAX(mbd.address) AS address,
         MAX(mbd.latitude) AS latitude,
         MAX(mbd.longitude) AS longitude,
         MAX(mbd.opening_time) AS opening_time,
         MAX(mbd.closing_time) AS closing_time,
         MAX(mbd.min_amount_for_fd) AS min_amount_for_fd,
         MAX(u.user_id) AS user_id,
         MAX(u.user_name) AS user_name,
         MAX(u.email) AS email,
         MAX(u.phone) AS phone,
         MAX(u.profile_image) AS profile_image,
         MAX(mbd.complementary) AS complement,
         MAX(mbd.complementary_details) AS complement_details,
         COALESCE(ROUND(AVG(mr.rating), 2), 0) AS avg_rating,
         SUM(CASE WHEN mr.comment IS NOT NULL AND mr.comment <> '' THEN 1 ELSE 0 END) AS total_comments,
         GROUP_CONCAT(DISTINCT bt.name) AS tags,
         MAX(mbd.special_celebration_discount_percentage) AS special_celebration_discount_percentage,
         MAX(mbd.special_celebration) AS special_celebration -- Added special_celebration
      FROM merchant_business_details mbd
      JOIN users u ON u.user_id = mbd.user_id
      LEFT JOIN merchant_business_types mbt ON mbt.business_id = mbd.business_id
      LEFT JOIN business_types bt ON bt.id = mbt.business_type_id
      LEFT JOIN mart_ratings mr ON mr.business_id = mbd.business_id
      WHERE TRIM(LOWER(mbd.owner_type)) = 'mart'
      ${whereSearch}
      GROUP BY mbd.business_id
      ORDER BY MAX(mbd.created_at) DESC, mbd.business_id DESC
      LIMIT ? OFFSET ?`,
      params,
    );

    return res.status(200).json({
      success: true,
      kind: "mart",
      count: rows.length,
      data: rows,
    });
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

    const params = [];
    let whereSearch =
      "AND mbd.special_celebration_discount_percentage IS NOT NULL";
    if (q) {
      whereSearch += ` AND (LOWER(mbd.business_name) LIKE ? OR LOWER(u.user_name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit, offset);

    const [rows] = await db.query(
      `SELECT
        mbd.business_id,
        MAX(mbd.business_name) AS business_name,
        MAX(mbd.owner_type) AS owner_type,
        MAX(mbd.business_logo) AS business_logo,
        MAX(mbd.address) AS address,
        MAX(mbd.latitude) AS latitude,
        MAX(mbd.longitude) AS longitude,
        MAX(mbd.opening_time) AS opening_time,
        MAX(mbd.closing_time) AS closing_time,
        MAX(mbd.min_amount_for_fd) AS min_amount_for_fd,
        MAX(u.user_id) AS user_id,
        MAX(u.user_name) AS user_name,
        MAX(u.email) AS email,
        MAX(u.phone) AS phone,
        MAX(u.profile_image) AS profile_image,
        MAX(mbd.complementary) AS complement,
        MAX(mbd.complementary_details) AS complement_details,
        COALESCE(ROUND(AVG(fr.rating), 2), 0) AS avg_rating,
        SUM(CASE WHEN fr.comment IS NOT NULL AND fr.comment <> '' THEN 1 ELSE 0 END) AS total_comments,
        GROUP_CONCAT(DISTINCT bt.name) AS tags,
        MAX(mbd.special_celebration_discount_percentage) AS special_celebration_discount_percentage,
        MAX(mbd.special_celebration) AS special_celebration
      FROM merchant_business_details mbd
      JOIN users u ON u.user_id = mbd.user_id
      LEFT JOIN merchant_business_types mbt ON mbt.business_id = mbd.business_id
      LEFT JOIN business_types bt ON bt.id = mbt.business_type_id
      LEFT JOIN food_ratings fr ON fr.business_id = mbd.business_id
      WHERE TRIM(LOWER(mbd.owner_type)) = 'food'
      ${whereSearch}
      GROUP BY mbd.business_id
      ORDER BY MAX(mbd.created_at) DESC, mbd.business_id DESC
      LIMIT ? OFFSET ?`,
      params,
    );

    return res.status(200).json({
      success: true,
      kind: "food",
      count: rows.length,
      data: rows,
    });
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

    const params = [];
    let whereSearch =
      "AND mbd.special_celebration_discount_percentage IS NOT NULL";
    if (q) {
      whereSearch += ` AND (LOWER(mbd.business_name) LIKE ? OR LOWER(u.user_name) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit, offset);

    const [rows] = await db.query(
      `SELECT
        mbd.business_id,
        MAX(mbd.business_name) AS business_name,
        MAX(mbd.owner_type) AS owner_type,
        MAX(mbd.business_logo) AS business_logo,
        MAX(mbd.address) AS address,
        MAX(mbd.latitude) AS latitude,
        MAX(mbd.longitude) AS longitude,
        MAX(mbd.opening_time) AS opening_time,
        MAX(mbd.closing_time) AS closing_time,
        MAX(mbd.min_amount_for_fd) AS min_amount_for_fd,
        MAX(u.user_id) AS user_id,
        MAX(u.user_name) AS user_name,
        MAX(u.email) AS email,
        MAX(u.phone) AS phone,
        MAX(u.profile_image) AS profile_image,
        MAX(mbd.complementary) AS complement,
        MAX(mbd.complementary_details) AS complement_details,
        COALESCE(ROUND(AVG(mr.rating), 2), 0) AS avg_rating,
        SUM(CASE WHEN mr.comment IS NOT NULL AND mr.comment <> '' THEN 1 ELSE 0 END) AS total_comments,
        GROUP_CONCAT(DISTINCT bt.name) AS tags,
        MAX(mbd.special_celebration_discount_percentage) AS special_celebration_discount_percentage,
        MAX(mbd.special_celebration) AS special_celebration
      FROM merchant_business_details mbd
      JOIN users u ON u.user_id = mbd.user_id
      LEFT JOIN merchant_business_types mbt ON mbt.business_id = mbd.business_id
      LEFT JOIN business_types bt ON bt.id = mbt.business_type_id
      LEFT JOIN mart_ratings mr ON mr.business_id = mbd.business_id
      WHERE TRIM(LOWER(mbd.owner_type)) = 'mart'
      ${whereSearch}
      GROUP BY mbd.business_id
      ORDER BY MAX(mbd.created_at) DESC, mbd.business_id DESC
      LIMIT ? OFFSET ?`,
      params,
    );

    return res.status(200).json({
      success: true,
      kind: "mart",
      count: rows.length,
      data: rows,
    });
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
