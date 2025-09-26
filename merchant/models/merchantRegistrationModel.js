// models/merchantRegistrationModel.js
const db = require("../config/db");
const bcrypt = require("bcryptjs");

/* ------------------------ helpers ------------------------ */

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

async function mapTypeNamesToIds(names) {
  if (!names || !names.length) return [];
  const trimmed = names.map((x) => String(x).trim()).filter(Boolean);
  if (!trimmed.length) return [];
  const [rows] = await db.query(
    `SELECT id, name FROM business_types
      WHERE LOWER(name) IN (${trimmed.map(() => "LOWER(?)").join(",")})`,
    trimmed
  );
  return rows.map((r) => r.id);
}

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

/* ------------------------ create/register ------------------------ */

async function registerMerchantModel(data) {
  const conn = await db.getConnection();
  await conn.beginTransaction();

  try {
    const {
      user_name,
      email,
      phone,
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
      owner_type, // e.g., "food" / "mart"
      bank_name,
      account_holder_name,
      account_number,
      bank_card_front_image,
      bank_card_back_image,
      bank_qr_code_image,
    } = data;

    const role = (data.role || "merchant").toLowerCase();
    const ownerType = String(owner_type || "").toLowerCase();

    if (!user_name) throw new Error("user_name is required");
    if (!email) throw new Error("email is required");
    if (!phone) throw new Error("phone is required");
    if (!password) throw new Error("password is required");
    if (!business_name) throw new Error("business_name is required");
    if (!ownerType) throw new Error("owner_type is required");
    if (!bank_name) throw new Error("bank_name is required");
    if (!account_holder_name)
      throw new Error("account_holder_name is required");
    if (!account_number) throw new Error("account_number is required");

    // Business type resolution
    let incomingIds = toIdArray(business_type_ids);
    if (
      !incomingIds.length &&
      Array.isArray(business_types) &&
      business_types.length
    ) {
      const mapped = await mapTypeNamesToIds(business_types);
      incomingIds = toIdArray(mapped);
    }
    if (!incomingIds.length)
      throw new Error(
        "At least one business type is required (provide business_type_ids)."
      );

    // Duplicate checks
    // Email: case-insensitive
    const [emailDup] = await conn.query(
      `SELECT user_id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email]
    );
    if (emailDup.length)
      throw new Error("Email already exists. Please use another email.");

    // Phone: exact
    const [phoneDup] = await conn.query(
      `SELECT user_id FROM users WHERE phone = ? LIMIT 1`,
      [phone]
    );
    if (phoneDup.length)
      throw new Error("Phone number already exists. Please use another phone.");

    // Username duplicate *scoped* by role+owner_type, and now **case-sensitive** on username
    const [scopedUserDup] = await conn.query(
      `
      SELECT u.user_id
        FROM users u
        JOIN merchant_business_details mbd
          ON mbd.user_id = u.user_id
       WHERE BINARY TRIM(u.user_name) = BINARY TRIM(?)
         AND LOWER(u.role) = LOWER(?)
         AND LOWER(TRIM(mbd.owner_type)) = LOWER(TRIM(?))
       LIMIT 1
      `,
      [user_name, role, ownerType]
    );
    if (scopedUserDup.length) {
      throw new Error(
        "Username already exists for this owner type. Choose another username or change owner_type."
      );
    }

    // Create user row (same spelling/case allowed only across different scopes as defined above)
    const password_hash = await bcrypt.hash(password, 10);
    const [uRes] = await conn.query(
      `INSERT INTO users (user_name, email, phone, password_hash, role, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [user_name, email, phone, password_hash, role]
    );
    const user_id = uRes.insertId;

    // Create business for that user (binds the owner_type)
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
        ownerType || null,
      ]
    );
    const business_id = mbdRes.insertId;

    const validTypeIds = await filterValidTypeIds(incomingIds);
    if (!validTypeIds.length)
      throw new Error("Provided business_type_ids are invalid.");
    const values = validTypeIds.map((tid) => [business_id, tid]);
    await conn.query(
      `INSERT INTO merchant_business_types (business_id, business_type_id) VALUES ?`,
      [values]
    );

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

/* ------------------------ UPDATE: business details ------------------------ */

async function updateMerchantDetailsModel(business_id, data) {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [exists] = await conn.query(
      `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
      [business_id]
    );
    if (!exists.length) throw new Error("Business not found");

    const sets = [];
    const params = [];
    const setIfProvided = (col, val, tx = (v) => v) => {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        params.push(tx(val));
      }
    };

    setIfProvided("business_name", data.business_name);
    setIfProvided("business_license_number", data.business_license_number);
    setIfProvided("license_image", data.license_image);
    setIfProvided("latitude", data.latitude, (v) =>
      v === "" || v === null ? null : Number(v)
    );
    setIfProvided("longitude", data.longitude, (v) =>
      v === "" || v === null ? null : Number(v)
    );
    setIfProvided("address", data.address);
    setIfProvided("business_logo", data.business_logo);
    setIfProvided("delivery_option", data.delivery_option);
    setIfProvided(
      "owner_type",
      data.owner_type ? String(data.owner_type).toLowerCase() : undefined
    );
    setIfProvided("opening_time", data.opening_time);
    setIfProvided("closing_time", data.closing_time);

    if (data.holidays !== undefined) {
      let arr = [];
      if (Array.isArray(data.holidays)) arr = data.holidays;
      else if (typeof data.holidays === "string") {
        try {
          const maybe = JSON.parse(data.holidays);
          arr = Array.isArray(maybe)
            ? maybe
            : String(data.holidays)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        } catch {
          arr = String(data.holidays)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      sets.push(`holidays = ?`);
      params.push(JSON.stringify(arr));
    }

    if (sets.length) {
      const sql = `UPDATE merchant_business_details SET ${sets.join(
        ", "
      )}, updated_at = CURRENT_TIMESTAMP WHERE business_id = ?`;
      params.push(business_id);
      await conn.query(sql, params);
    }

    let incomingIds = toIdArray(data.business_type_ids);
    if (
      !incomingIds.length &&
      Array.isArray(data.business_types) &&
      data.business_types.length
    ) {
      const mapped = await mapTypeNamesToIds(data.business_types);
      incomingIds = toIdArray(mapped);
    }
    if (
      data.business_type_ids !== undefined ||
      data.business_types !== undefined
    ) {
      const validIds = await filterValidTypeIds(incomingIds);
      await conn.query(
        `DELETE FROM merchant_business_types WHERE business_id = ?`,
        [business_id]
      );
      if (validIds.length) {
        const values = validIds.map((tid) => [business_id, tid]);
        await conn.query(
          `INSERT INTO merchant_business_types (business_id, business_type_id) VALUES ?`,
          [values]
        );
      }
    }

    await conn.commit();
    conn.release();
    return { business_id };
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
}

/* ------------------------ FINDERS ------------------------ */

/**
 * Return ALL accounts whose username matches EXACT CASE (case-sensitive),
 * newest first. Controller decides which one matches the password.
 */
async function findCandidatesByUsername(user_name) {
  const uname = String(user_name || "");
  const [rows] = await db.query(
    `
    SELECT user_id, user_name, email, phone, role, password_hash, is_active
      FROM users
     WHERE BINARY TRIM(user_name) = BINARY TRIM(?)
     ORDER BY user_id DESC
    `,
    [uname]
  );
  return rows || [];
}

/* ------------------------ owners by kind (unchanged) ------------------------ */

async function getOwnersByKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (!["food", "mart"].includes(k))
    throw new Error("kind must be 'food' or 'mart'");

  const [bizRows] = await db.query(
    `SELECT
        mbd.business_id, mbd.user_id, mbd.owner_type, mbd.business_name,
        mbd.business_license_number, mbd.license_image,
        mbd.latitude, mbd.longitude, mbd.address,
        mbd.business_logo, mbd.delivery_option,
        mbd.opening_time, mbd.closing_time, mbd.holidays,
        mbd.complementary AS complement, mbd.complementary_details AS complement_details,
        mbd.created_at, mbd.updated_at,
        u.user_name, u.email, u.phone, u.profile_image
     FROM merchant_business_details mbd
     JOIN users u ON u.user_id = mbd.user_id
     WHERE EXISTS (
       SELECT 1
         FROM merchant_business_types mbt
         JOIN business_types bt ON bt.id = mbt.business_type_id
        WHERE mbt.business_id = mbd.business_id
          AND LOWER(bt.types) = ?
     )
     ORDER BY mbd.business_name ASC`,
    [k]
  );

  if (!bizRows.length) return [];

  const ids = bizRows.map((b) => b.business_id);
  const ph = ids.map(() => "?").join(",");

  const [typeRows] = await db.query(
    `SELECT mbt.business_id, bt.id AS business_type_id, bt.name
       FROM merchant_business_types mbt
       JOIN business_types bt ON bt.id = mbt.business_type_id
      WHERE mbt.business_id IN (${ph})
        AND LOWER(bt.types) = ?
      ORDER BY bt.name ASC`,
    [...ids, k]
  );

  const typesByBiz = new Map();
  for (const r of typeRows) {
    if (!typesByBiz.has(r.business_id)) typesByBiz.set(r.business_id, []);
    typesByBiz
      .get(r.business_id)
      .push({ business_type_id: r.business_type_id, name: r.name });
  }

  const [ratingRows] = await db.query(
    `SELECT
        fm.business_id,
        AVG(fmr.rating) AS avg_rating,
        COUNT(fmr.comment) AS total_comments
     FROM food_menu fm
     LEFT JOIN food_menu_ratings fmr ON fmr.menu_id = fm.id
     WHERE fm.business_id IN (${ph})
     GROUP BY fm.business_id`,
    ids
  );

  const ratingsByBiz = new Map();
  for (const row of ratingRows) {
    ratingsByBiz.set(row.business_id, {
      avg_rating: row.avg_rating || 0,
      total_comments: row.total_comments || 0,
    });
  }

  return bizRows.map((b) => ({
    business_id: b.business_id,
    owner_type: b.owner_type,
    business_name: b.business_name,
    business_license_number: b.business_license_number,
    license_image: b.license_image,
    latitude: b.latitude,
    longitude: b.longitude,
    address: b.address,
    business_logo: b.business_logo,
    delivery_option: b.delivery_option,
    opening_time: b.opening_time,
    closing_time: b.closing_time,
    holidays: b.holidays,
    complement: b.complement,
    complement_details: b.complementary_details,
    created_at: b.created_at,
    updated_at: b.updated_at,
    user: {
      user_id: b.user_id,
      user_name: b.user_name,
      email: b.email,
      phone: b.phone,
      profile_image: b.profile_image || null,
    },
    business_types: typesByBiz.get(b.business_id) || [],
    avg_rating: ratingsByBiz.get(b.business_id)?.avg_rating || 0,
    total_comments: ratingsByBiz.get(b.business_id)?.total_comments || 0,
  }));
}

async function getFoodOwners() {
  return getOwnersByKind("food");
}
async function getMartOwners() {
  return getOwnersByKind("mart");
}

module.exports = {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByUsername, // case-sensitive now
  getOwnersByKind,
  getFoodOwners,
  getMartOwners,
};
