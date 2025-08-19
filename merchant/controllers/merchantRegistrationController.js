// controllers/merchantController.js
const fs = require("fs");
const path = require("path");
const {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findUserByUsername,
} = require("../models/merchantRegistrationModel"); // ensure this path matches your project
const db = require("../config/db"); // ⬅️ add this at top if not present

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Convert multer file to stored relative path like "/uploads/xxx/filename.png"
const toRelPath = (fileObj) => {
  if (!fileObj) return null;
  let p = String(fileObj.path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("uploads/");
  if (i !== -1) p = p.slice(i);
  p = p.replace(/^\/+/, "");
  return `/${p}`;
};

// Accept body value and return a stored relative path (no host)
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

// ---- helpers to safely delete old uploaded files (after successful DB update)
const UPLOAD_ROOT_ABS = path.join(process.cwd(), "uploads");
const isUploadsPath = (p) => typeof p === "string" && /^\/?uploads\//i.test(p.replace(/^\/+/, ""));
const toAbsPath = (webPath) => path.join(process.cwd(), webPath.replace(/^\//, "")); // "/uploads/..." -> absolute

function deleteIfReplaced(oldPath, newPath) {
  // Only delete if:
  //  - old exists
  //  - old !== new (different file)
  //  - path is under /uploads
  if (!oldPath || !newPath) return;
  const oldNorm = String(oldPath).trim();
  const newNorm = String(newPath).trim();
  if (!oldNorm || !isUploadsPath(oldNorm)) return;
  if (oldNorm === newNorm) return;

  const abs = toAbsPath(oldNorm);
  // Guardrail: ensure inside uploads root
  if (!abs.startsWith(UPLOAD_ROOT_ABS)) return;

  fs.stat(abs, (err, st) => {
    if (err || !st?.isFile()) return;
    fs.unlink(abs, () => {}); // best-effort delete
  });
}

/* -------------------- register (unchanged) -------------------- */
async function registerMerchant(req, res) {
  try {
    const f = req.files || {};
    const b = req.body || {};

    const license_image = f.license_image?.[0] ? toRelPath(f.license_image[0]) : fromBodyToStoredPath(b.license_image);
    const business_logo = f.business_logo?.[0] ? toRelPath(f.business_logo[0]) : fromBodyToStoredPath(b.business_logo);
    const bank_card_front_image = f.bank_card_front_image?.[0] ? toRelPath(f.bank_card_front_image[0]) : fromBodyToStoredPath(b.bank_card_front_image);
    const bank_card_back_image = f.bank_card_back_image?.[0] ? toRelPath(f.bank_card_back_image[0]) : fromBodyToStoredPath(b.bank_card_back_image);
    const bank_qr_code_image = f.bank_qr_code_image?.[0] ? toRelPath(f.bank_qr_code_image[0]) : fromBodyToStoredPath(b.bank_qr_code_image);

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
        ? b.business_types.split(",").map((x) => x.trim()).filter(Boolean)
        : undefined,
      business_license_number: b.business_license_number,
      license_image,
      latitude:
        b.latitude !== undefined && b.latitude !== "" && !isNaN(Number(b.latitude))
          ? Number(b.latitude)
          : null,
      longitude:
        b.longitude !== undefined && b.longitude !== "" && !isNaN(Number(b.longitude))
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
    res.status(isClientErr ? 400 : 500).json({ error: err.message || "Merchant registration failed" });
  }
}

/* -------------------- UPDATE business details (supports single-field, deletes old image) -------------------- */
async function updateMerchant(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    if (!Number.isInteger(business_id) || business_id <= 0) {
      return res.status(400).json({ error: "Invalid businessId" });
    }

    // Fetch existing to know old image paths
    const [rows] = await require("../config/db").query(
      `SELECT license_image, business_logo FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
      [business_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Business not found" });
    const oldLicense = rows[0].license_image || null;
    const oldLogo = rows[0].business_logo || null;

    const f = req.files || {};
    const b = req.body || {};

    // optional file overrides (new values)
    const newLicenseImage = f.license_image?.[0] ? toRelPath(f.license_image[0]) : fromBodyToStoredPath(b.license_image);
    const newBusinessLogo = f.business_logo?.[0] ? toRelPath(f.business_logo[0]) : fromBodyToStoredPath(b.business_logo);

    // Build partial update payload — include ONLY fields you send
    const updatePayload = {};

    // simple scalars (send one field? it's fine—only that one is updated)
    ["business_name","business_license_number","address","delivery_option","owner_type","opening_time","closing_time"].forEach((k) => {
      if (b[k] !== undefined) updatePayload[k] = b[k];
    });

    // files
    if (b.license_image !== undefined || f.license_image?.length) {
      updatePayload.license_image = newLicenseImage; // may be null if invalid path
    }
    if (b.business_logo !== undefined || f.business_logo?.length) {
      updatePayload.business_logo = newBusinessLogo;
    }

    // numeric
    if (b.latitude !== undefined) {
      updatePayload.latitude = b.latitude === "" ? null : Number(b.latitude);
    }
    if (b.longitude !== undefined) {
      updatePayload.longitude = b.longitude === "" ? null : Number(b.longitude);
    }

    // holidays: accept array, CSV, or JSON array string
    if (b.holidays !== undefined) {
      if (Array.isArray(b.holidays)) {
        updatePayload.holidays = b.holidays;
      } else if (typeof b.holidays === "string") {
        updatePayload.holidays = b.holidays; // model will parse
      } else {
        updatePayload.holidays = []; // fallback to empty
      }
    }

    // categories replace (optional)
    if (b.business_type_ids !== undefined) updatePayload.business_type_ids = b.business_type_ids;
    if (b.business_types !== undefined) {
      updatePayload.business_types = Array.isArray(b.business_types)
        ? b.business_types
        : String(b.business_types).split(",").map((x) => x.trim()).filter(Boolean);
    }

    // Perform DB update (partial)
    const out = await updateMerchantDetailsModel(business_id, updatePayload);

    // After successful DB commit: delete replaced images (safely)
    if (updatePayload.license_image) {
      deleteIfReplaced(oldLicense, updatePayload.license_image);
    }
    if (updatePayload.business_logo) {
      deleteIfReplaced(oldLogo, updatePayload.business_logo);
    }

    return res.status(200).json({
      message: "Business details updated",
      business_id: out.business_id,
    });
  } catch (err) {
    console.error("updateMerchant error:", err);
    const isClientErr = /not found|invalid/i.test(err.message || "");
    return res.status(isClientErr ? 404 : 500).json({ error: err.message || "Update failed" });
  }
}

/* -------------------- login (unchanged) -------------------- */
// async function loginByUsername(req, res) {
//   try {
//     const { user_name, password } = req.body || {};
//     if (!user_name || !password) {
//       return res.status(400).json({ error: "user_name and password are required" });
//     }

//     const user = await findUserByUsername(user_name);
//     if (!user) return res.status(404).json({ error: "User not found" });

//     if (user.is_active !== undefined && Number(user.is_active) === 0) {
//       return res.status(403).json({ error: "Account is deactivated. Please contact support." });
//     }

//     const ok = await bcrypt.compare(password, user.password_hash);
//     if (!ok) return res.status(401).json({ error: "Incorrect password" });

//     const payload = { user_id: user.user_id, role: user.role, user_name: user.user_name };
//     const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "1m" });
//     const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: "10m" });

//     return res.status(200).json({
//       message: "Login successful",
//       token: {
//         access_token,
//         access_token_time: 1,
//         refresh_token,
//         refresh_token_time: 10,
//       },
//       user: {
//         user_id: user.user_id,
//         user_name: user.user_name,
//         phone: user.phone,
//         role: user.role,
//         email: user.email,
//       },
//     });
//   } catch (err) {
//     console.error("loginByUsername error:", err);
//     return res.status(500).json({ error: "Login failed due to server error" });
//   }
// }
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

    // 🔎 Fetch owner_type (and business_id) from merchant_business_details
    // If multiple businesses exist, take the latest by created_at (fallback to highest business_id).
    const [bizRows] = await db.query(
      `SELECT business_id,business_name, owner_type, business_logo,address
         FROM merchant_business_details
        WHERE user_id = ?
        ORDER BY created_at DESC, business_id DESC
        LIMIT 1`,
      [user.user_id]
    );

    const owner_type = bizRows[0]?.owner_type ?? null;
    const business_id = bizRows[0]?.business_id ?? null;
    const business_name = bizRows[0]?.business_name ?? null;
    const business_logo = bizRows[0]?.business_logo ?? null;
    const address = bizRows[0]?.address ?? null;



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
        owner_type,   // ⬅️ added
        business_id,  // ⬅️ handy to have alongside owner_type
      business_name,
      business_logo,
      address
      },
    });
  } catch (err) {
    console.error("loginByUsername error:", err);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
}
module.exports = { registerMerchant, updateMerchant, loginByUsername };
