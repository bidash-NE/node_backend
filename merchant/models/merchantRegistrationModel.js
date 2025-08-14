// models/merchantModel.js
const db = require("../config/db");
const bcrypt = require("bcrypt");

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
      business_type,
      business_license_number,
      license_image,
      latitude,
      longitude,
      address,
      business_logo,
      delivery_option,
      owner_type, // Added owner_type

      // bank
      bank_name,
      account_holder_name,
      account_number,
      bank_card_front_image,
      bank_card_back_image,
      bank_qr_code_image,
    } = data;

    // ---- Basic required checks (fast fail) ----
    if (!user_name) throw new Error("user_name is required");
    if (!email) throw new Error("email is required");
    if (!phone) throw new Error("phone is required");
    if (!password) throw new Error("password is required");
    if (!business_name) throw new Error("business_name is required");
    if (!business_type) throw new Error("business_type is required");
    if (!owner_type) throw new Error("owner_type is required"); // Check for owner_type
    if (!bank_name) throw new Error("bank_name is required");
    if (!account_holder_name)
      throw new Error("account_holder_name is required");
    if (!account_number) throw new Error("account_number is required");

    // ---- Duplicate checks ----
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

    // ---- Insert users ----
    const password_hash = await bcrypt.hash(password, 10);
    const [uRes] = await conn.query(
      `INSERT INTO users (user_name, email, phone, password_hash, role)
   VALUES (?, ?, ?, ?, ?)`,

      [user_name, email, phone, password_hash, data.role || "merchant"]
    );
    const user_id = uRes.insertId;

    // ---- Insert merchant_business_details (added owner_type) ----
    await conn.query(
      `INSERT INTO merchant_business_details
        (user_id, business_name, business_type, business_license_number, license_image,
         latitude, longitude, address, business_logo, delivery_option, owner_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

      [
        user_id,
        business_name,
        business_type,
        business_license_number || null,
        license_image || null,
        latitude ?? null,
        longitude ?? null,
        address || null,
        business_logo || null,
        delivery_option || "SELF",
        owner_type || null, // Insert owner_type
      ]
    );

    // ---- Insert merchant_bank_details ----
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
    return { user_id };
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
