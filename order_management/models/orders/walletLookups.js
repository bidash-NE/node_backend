// orders/walletLookups.js
// ✅ Keep raw SQL intentionally for now
// ✅ Reason: walletCaptureEngine.js still uses MySQL transaction connection
// ✅ These lookup functions must use the same conn passed from walletCaptureEngine
// ✅ Preserves transaction consistency for wallet capture flow

const db = require("../../config/db");

/* ======================= CONFIG ======================= */

const ADMIN_WALLET_ID = process.env.ADMIN_WALLET_ID;

/* ======================= HELPERS ======================= */

function getDb(conn = null) {
  return conn || db;
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function requireAdminWalletId() {
  const walletId = String(ADMIN_WALLET_ID || "").trim();

  if (!walletId) {
    throw new Error("ADMIN_WALLET_ID is missing in environment variables.");
  }

  return walletId;
}

/* ================= WALLET LOOKUPS ================= */

async function getBuyerWalletByUserId(user_id, conn = null) {
  const dbh = getDb(conn);
  const uid = toPositiveNumber(user_id);

  if (!uid) {
    return null;
  }

  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status
       FROM wallets
      WHERE user_id = ?
      LIMIT 1`,
    [uid],
  );

  return rows[0] || null;
}

async function getAdminWallet(conn = null) {
  const dbh = getDb(conn);
  const adminWalletId = requireAdminWalletId();

  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status
       FROM wallets
      WHERE wallet_id = ?
      LIMIT 1`,
    [adminWalletId],
  );

  return rows[0] || null;
}

async function getMerchantWalletByBusinessId(business_id, conn = null) {
  const dbh = getDb(conn);
  const bid = toPositiveNumber(business_id);

  if (!bid) {
    return null;
  }

  const [rows] = await dbh.query(
    `
    SELECT w.id, w.wallet_id, w.user_id, w.amount, w.status
      FROM merchant_business_details m
      JOIN wallets w ON w.user_id = m.user_id
     WHERE m.business_id = ?
     LIMIT 1
    `,
    [bid],
  );

  return rows[0] || null;
}

module.exports = {
  ADMIN_WALLET_ID,
  getBuyerWalletByUserId,
  getAdminWallet,
  getMerchantWalletByBusinessId,
};