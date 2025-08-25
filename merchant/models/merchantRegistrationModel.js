// models/merchantModel.js
const db = require("../config/db");
const bcrypt = require("bcrypt");

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

/* ------------------------ create/register (existing) ------------------------ */

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
      owner_type,
      bank_name,
      account_holder_name,
      account_number,
      bank_card_front_image,
      bank_card_back_image,
      bank_qr_code_image,
    } = data;

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
    if (acctDup.length)
      throw new Error(
        "Bank account number already exists. Please use another account."
      );

    const password_hash = await bcrypt.hash(password, 10);
    const [uRes] = await conn.query(
      `INSERT INTO users (user_name, email, phone, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      [user_name, email, phone, password_hash, data.role || "merchant"]
    );
    const user_id = uRes.insertId;

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
    setIfProvided("owner_type", data.owner_type);
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

/* ------------------------ NEW: fetch owners by kind ------------------------ */

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
  findUserByUsername,
  // NEW
  getOwnersByKind,
  getFoodOwners,
  getMartOwners,
};
