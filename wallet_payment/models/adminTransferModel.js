// models/adminTransferModel.js
const db = require("../config/db");
const crypto = require("crypto");

const ADMIN_ROLES = ["admin", "super admin"]; // lowercased comparison

function makeTxnId() {
  return (
    "TNX" + Date.now() + crypto.randomBytes(2).toString("hex").toUpperCase()
  );
}

/** Find admin by users.user_name (case-insensitive) with allowed role */
async function findAdminByUserName(conn, admin_name) {
  const [rows] = await conn.query(
    `SELECT user_id, user_name, role
       FROM users
      WHERE LOWER(user_name) = LOWER(?)
        AND LOWER(role) IN (?, ?)
      LIMIT 1`,
    [admin_name, ADMIN_ROLES[0], ADMIN_ROLES[1]]
  );
  return rows[0] || null;
}

/**
 * Admin Tip Transfer:
 * - verifies admin (user_name + role)
 * - locks both wallets (FOR UPDATE)
 * - validates ACTIVE status and sufficient balance
 * - updates balances (DECIMAL)
 * - inserts 2 wallet_transactions (DR & CR) with wallet_id in tnx_from/tnx_to
 * - inserts `note` into both records
 * - logs admin action in admin_logs
 */
async function adminTipTransfer({
  admin_name,
  admin_wallet_id,
  user_wallet_id,
  amount_nu,
  note = "",
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1️⃣ Verify admin user
    const adminUser = await findAdminByUserName(conn, admin_name);
    if (!adminUser) {
      await conn.rollback();
      return {
        ok: false,
        status: 403,
        message: "Admin not found or not permitted.",
      };
    }

    // 2️⃣ Lock wallets
    const [[adminW]] = await conn.query(
      "SELECT * FROM wallets WHERE wallet_id = ? FOR UPDATE",
      [admin_wallet_id]
    );
    const [[userW]] = await conn.query(
      "SELECT * FROM wallets WHERE wallet_id = ? FOR UPDATE",
      [user_wallet_id]
    );

    // 3️⃣ Validate wallets
    if (!adminW) {
      await conn.rollback();
      return { ok: false, status: 404, message: "Admin wallet not found." };
    }
    if (!userW) {
      await conn.rollback();
      return { ok: false, status: 404, message: "User wallet not found." };
    }
    if (adminW.status !== "ACTIVE") {
      await conn.rollback();
      return { ok: false, status: 409, message: "Admin wallet is not ACTIVE." };
    }
    if (userW.status !== "ACTIVE") {
      await conn.rollback();
      return { ok: false, status: 409, message: "User wallet is not ACTIVE." };
    }

    // 4️⃣ Validate amount
    const amt = Number(amount_nu);
    if (!isFinite(amt) || amt <= 0) {
      await conn.rollback();
      return {
        ok: false,
        status: 400,
        message: "Amount must be a positive number (Nu).",
      };
    }
    if (Number(adminW.amount) < amt) {
      await conn.rollback();
      return {
        ok: false,
        status: 409,
        message: "Insufficient admin wallet balance.",
      };
    }
    const amtStr = amt.toFixed(2);

    // 5️⃣ Update balances using numeric IDs
    await conn.query("UPDATE wallets SET amount = amount - ? WHERE id = ?", [
      amtStr,
      adminW.id,
    ]);
    await conn.query("UPDATE wallets SET amount = amount + ? WHERE id = ?", [
      amtStr,
      userW.id,
    ]);

    // 6️⃣ Create journal + transaction IDs
    const journal_code =
      "JRN" + crypto.randomBytes(6).toString("hex").toUpperCase();
    const txnAdmin = makeTxnId();
    const txnUser = makeTxnId();

    // 7️⃣ Insert wallet transactions (using wallet IDs + note)
    await conn.query(
      `INSERT INTO wallet_transactions 
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note)
       VALUES (?, ?, ?, ?, ?, 'DR', ?)`,
      [txnAdmin, journal_code, adminW.wallet_id, userW.wallet_id, amtStr, note]
    );

    await conn.query(
      `INSERT INTO wallet_transactions 
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note)
       VALUES (?, ?, ?, ?, ?, 'CR', ?)`,
      [txnUser, journal_code, adminW.wallet_id, userW.wallet_id, amtStr, note]
    );

    // 8️⃣ Log admin action
    const activity =
      `TIP_TRANSFER: ${adminUser.user_name} [${adminUser.role}] sent Nu. ${amtStr} ` +
      `to ${userW.wallet_id} (user_id: ${userW.user_id}) from ${adminW.wallet_id}` +
      (note ? ` | ${note}` : "");
    await conn.query(
      `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`,
      [userW.user_id, adminUser.user_name, activity]
    );

    // 9️⃣ Get updated balances
    const [[adminNew]] = await conn.query(
      "SELECT * FROM wallets WHERE id = ?",
      [adminW.id]
    );
    const [[userNew]] = await conn.query("SELECT * FROM wallets WHERE id = ?", [
      userW.id,
    ]);

    await conn.commit();

    // ✅ Return response
    return {
      ok: true,
      journal_code,
      amount: amtStr,
      note,
      admin_verified: {
        user_id: adminUser.user_id,
        user_name: adminUser.user_name,
        role: adminUser.role,
      },
      from: {
        wallet_id: adminNew.wallet_id,
        user_id: adminNew.user_id,
        balance:
          typeof adminNew.amount === "string"
            ? adminNew.amount
            : Number(adminNew.amount).toFixed(2),
      },
      to: {
        wallet_id: userNew.wallet_id,
        user_id: userNew.user_id,
        balance:
          typeof userNew.amount === "string"
            ? userNew.amount
            : Number(userNew.amount).toFixed(2),
      },
      transactions: { admin_dr: txnAdmin, user_cr: txnUser },
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { adminTipTransfer };
