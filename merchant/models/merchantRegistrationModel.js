// models/merchantModel.js
const db = require("../config/db");
const bcrypt = require("bcrypt");

/* ------------------------ helpers ------------------------ */

/** Normalize an input (array or CSV string) to a deduped array of positive ints. */
function toIdArray(input) {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : String(input).split(",");
  const out = [];
  for (const p of parts) {
    const n = Number(String(p).trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Map an array of type names (case-sensitive or insensitive) to IDs. */
async function mapTypeNamesToIds(names) {
  if (!names || !names.length) return [];
  const trimmed = names.map((x) => String(x).trim()).filter(Boolean);

  if (!trimmed.length) return [];

  // Use case-insensitive match on name
  const [rows] = await db.query(
    `SELECT id, name
       FROM business_types
      WHERE LOWER(name) IN (${trimmed.map(() => "LOWER(?)").join(",")})`,
    trimmed
  );
  const found = rows.map((r) => r.id);
  return found;
}

/** Filter provided IDs to only those that exist in business_types. */
async function filterValidTypeIds(typeIds) {
  if (!typeIds.length) return [];
  const [rows] = await db.query(
    `SELECT id FROM business_types WHERE id IN (${typeIds
      .map(() => "?")
      .join(",")})`,
    typeIds
  );
  const valid = new Set(rows.map((r) => r.id));
  return typeIds.filter((id) => valid.has(id));
}

/* ------------------------ main API ------------------------ */

async function registerMerchantModel(data) {
  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    const {
      // users
      user_name,
      email,
      phone,
      password,

      // business
      business_name,
      // NEW: expect multiple IDs (preferred) or names as fallback
      business_type_ids, // e.g. [2,5,8] or "2,5,8"
      business_types, // e.g. ["Cafe","Bakery"] (optional fallback)
      business_license_number,
      license_image,
      latitude,
      longitude,
      address,
      business_logo,
      delivery_option,
      owner_type,

      // bank
      bank_name,
      account_holder_name,
      account_number,
      bank_card_front_image,
      bank_card_back_image,
      bank_qr_code_image,
    } = data;

    /* ---- Basic required checks (fast fail) ---- */
    if (!user_name) throw new Error("user_name is required");
    if (!email) throw new Error("email is required");
    if (!phone) throw new Error("phone is required");
    if (!password) throw new Error("password is required");
    if (!business_name) throw new Error("business_name is required");
    if (!owner_type) throw new Error("owner_type is required");
    if (!bank_name) throw new Error("bank_name is required");
    if (!account_holder_name)
      throw new Error("account_holder_name is required");
    if (!account_number) throw new Error("account_number is required");

    /* ---- Prepare business_type IDs ----
       Preferred: business_type_ids (array or CSV)
       Fallback:  business_types (array of names)
    */
    let incomingIds = toIdArray(business_type_ids);
    if (
      !incomingIds.length &&
      Array.isArray(business_types) &&
      business_types.length
    ) {
      const mapped = await mapTypeNamesToIds(business_types);
      incomingIds = toIdArray(mapped);
    }
    // Require at least one valid type
    if (!incomingIds.length) {
      throw new Error(
        "At least one business type is required (provide business_type_ids)."
      );
    }

    /* ---- Duplicate checks ---- */
    const [emailDup] = await conn.query(
      `SELECT user_id FROM users WHERE email = ? LIMIT 1`,
      [email]
    );
    if (emailDup.length)
      throw new Error("Email already exists. Please use another email.");

    const [phoneDup] = await conn.query(
      `SELECT user_id FROM users WHERE phone = ? LIMIT 1`,
      [phone]
    );
    if (phoneDup.length)
      throw new Error("Phone number already exists. Please use another phone.");

    const [acctDup] = await conn.query(
      `SELECT bank_detail_id FROM merchant_bank_details WHERE account_number = ? LIMIT 1`,
      [account_number]
    );
    if (acctDup.length) {
      throw new Error(
        "Bank account number already exists. Please use another account."
      );
    }

    /* ---- Insert users ---- */
    const password_hash = await bcrypt.hash(password, 10);
    const [uRes] = await conn.query(
      `INSERT INTO users (user_name, email, phone, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      [user_name, email, phone, password_hash, data.role || "merchant"]
    );
    const user_id = uRes.insertId;

    /* ---- Insert merchant_business_details
       NOTE: with many-to-many, there is NO single business_type column here.
    ---- */
    const [mbdRes] = await conn.query(
      `INSERT INTO merchant_business_details
        (user_id, business_name, business_license_number, license_image,
         latitude, longitude, address, business_logo, delivery_option, owner_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        business_name,
        business_license_number || null,
        license_image || null,
        latitude ?? null,
        longitude ?? null,
        address || null,
        business_logo || null,
        delivery_option || "SELF",
        owner_type || null,
      ]
    );
    const business_id = mbdRes.insertId;

    /* ---- Validate & insert business types into link table ---- */
    const validTypeIds = await filterValidTypeIds(incomingIds);
    if (!validTypeIds.length) {
      throw new Error("Provided business_type_ids are invalid.");
    }
    const values = validTypeIds.map((tid) => [business_id, tid]);
    await conn.query(
      `INSERT INTO merchant_business_types (business_id, business_type_id) VALUES ?`,
      [values]
    );

    /* ---- Insert merchant_bank_details ---- */
    await conn.query(
      `INSERT INTO merchant_bank_details
         (user_id, bank_name, account_holder_name, account_number,
          bank_card_front_image, bank_card_back_image, bank_qr_code_image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        bank_name,
        account_holder_name,
        account_number,
        bank_card_front_image || null,
        bank_card_back_image || null,
        bank_qr_code_image || null,
      ]
    );

    await conn.commit();
    conn.release();

    return {
      user_id,
      business_id,
      business_type_ids: validTypeIds,
      message: "Merchant registered successfully.",
    };
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
}

async function findUserByUsername(user_name) {
  const sql = `
    SELECT user_id, user_name, email, phone, role, password_hash, is_active
      FROM users
     WHERE user_name = ?
     LIMIT 1
  `;
  const [rows] = await db.query(sql, [user_name]);
  return rows[0] || null;
}

module.exports = { registerMerchantModel, findUserByUsername };
