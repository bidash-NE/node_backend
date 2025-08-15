// controllers/merchantController.js
const {
  registerMerchantModel,
  findUserByUsername,
} = require("../models/merchantRegistrationModel"); // keep your original path/name

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Convert multer file to a stored relative path like "/uploads/xxx/filename.png"
const toRelPath = (fileObj) => {
  if (!fileObj) return null;
  let p = String(fileObj.path || "").replace(/\\/g, "/"); // normalize slashes
  const i = p.lastIndexOf("uploads/");
  if (i !== -1) p = p.slice(i); // keep from "uploads/..."
  p = p.replace(/^\/+/, ""); // remove leading slashes if any
  return `/${p}`; // ensure single leading slash
};

// Accept body value and return a stored relative path (no host)
// - If already "/uploads/...": keep it
// - If absolute URL: strip to pathname "/uploads/..."
// - If "uploads/...": prefix "/" and keep
// - Otherwise: null (ignored)
const fromBodyToStoredPath = (val) => {
  if (!val) return null;
  const s = String(val).trim();
  if (s.startsWith("/uploads/")) return s;
  if (s.startsWith("uploads/")) return `/${s}`;
  try {
    const u = new URL(s);
    return u.pathname || null; // strips host, keeps "/path"
  } catch {
    return null; // not a URL and not an uploads path
  }
};

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

    // Support many-to-many business types:
    // - Preferred: b.business_type_ids (array or CSV, e.g. [2,5,8] or "2,5,8")
    // - Fallback:  b.business_types (array of names, e.g. ["Cafe", "Bakery"])
    // The model will normalize/validate these.
    const payload = {
      // users
      user_name: b.user_name,
      email: b.email,
      phone: b.phone,
      password: b.password,
      role: "merchant",

      // business
      business_name: b.business_name,
      // REMOVED: business_type (single) — now using many-to-many
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
      delivery_option: b.delivery_option, // 'SELF' | 'GRAB' | 'BOTH'
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
      business_type_ids: result.business_type_ids, // from model’s success payload
    });
  } catch (err) {
    console.error(err.message || err);
    const isClientErr = /exists|required|invalid/i.test(err.message || "");
    res
      .status(isClientErr ? 400 : 500)
      .json({ error: err.message || "Merchant registration failed" });
  }
}

async function loginByUsername(req, res) {
  try {
    const { user_name, password } = req.body || {};
    if (!user_name || !password) {
      return res
        .status(400)
        .json({ error: "user_name and password are required" });
    }

    const user = await findUserByUsername(user_name);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Block deactivated accounts
    if (user.is_active !== undefined && Number(user.is_active) === 0) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact support." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Incorrect password" });
    }

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
      },
    });
  } catch (err) {
    console.error("loginByUsername error:", err);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
}

module.exports = { registerMerchant, loginByUsername };
