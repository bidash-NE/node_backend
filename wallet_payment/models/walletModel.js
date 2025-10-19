// models/walletModel.js
const db = require("../config/db");

// helpers
const pad = (n, width = 6) => String(n).padStart(width, "0");
const makeWalletId = (numericId) => `NET${pad(numericId)}`;

/** Check user exists by users.user_id (same transaction/connection) */
async function userExists(conn, user_id) {
  const [rows] = await conn.query(
    "SELECT user_id FROM users WHERE user_id = ?",
    [user_id]
  );
  return rows.length > 0;
}

/** Resolve wallet numeric id from wallet_id (NET...), numeric id, or user_id */
async function resolveWalletNumericId({ key = null, user_id = null }) {
  if (user_id != null) {
    const [r] = await db.query("SELECT id FROM wallets WHERE user_id = ?", [
      user_id,
    ]);
    return r.length ? r[0].id : null;
  }
  if (!key) return null;

  if (/^NET/i.test(String(key))) {
    const [r] = await db.query("SELECT id FROM wallets WHERE wallet_id = ?", [
      key,
    ]);
    return r.length ? r[0].id : null;
  }
  if (/^\d+$/.test(String(key))) return Number(key);
  return null;
}

/** Create wallet (validates user exists, prevents duplicate) */
async function createWallet({ user_id, status = "ACTIVE" }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const exists = await userExists(conn, user_id);
    if (!exists) {
      await conn.rollback();
      return { error: "USER_NOT_FOUND" };
    }

    const [existing] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? FOR UPDATE",
      [user_id]
    );
    if (existing.length) {
      await conn.rollback();
      return { error: "WALLET_EXISTS", wallet: existing[0] };
    }

    const [ins] = await conn.query(
      "INSERT INTO wallets (wallet_id, user_id, amount, status) VALUES (NULL, ?, 0, ?)",
      [user_id, status]
    );

    const wallet_id = makeWalletId(ins.insertId);
    await conn.query("UPDATE wallets SET wallet_id = ? WHERE id = ?", [
      wallet_id,
      ins.insertId,
    ]);

    const [[row]] = await conn.query("SELECT * FROM wallets WHERE id = ?", [
      ins.insertId,
    ]);

    await conn.commit();
    return row;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Get wallet by key or user_id */
async function getWallet({ key = null, user_id = null }) {
  if (user_id != null) {
    const [rows] = await db.query("SELECT * FROM wallets WHERE user_id = ?", [
      user_id,
    ]);
    return rows[0] || null;
  }
  if (!key) return null;

  if (/^NET/i.test(String(key))) {
    const [rows] = await db.query("SELECT * FROM wallets WHERE wallet_id = ?", [
      key,
    ]);
    return rows[0] || null;
  }
  if (/^\d+$/.test(String(key))) {
    const [rows] = await db.query("SELECT * FROM wallets WHERE id = ?", [
      Number(key),
    ]);
    return rows[0] || null;
  }
  return null;
}

/** List wallets (supports GET /wallet?limit&offset&status) */
async function listWallets({ limit = 50, offset = 0, status = null }) {
  limit = Math.min(Number(limit) || 50, 200);
  offset = Number(offset) || 0;

  if (status) {
    const [rows] = await db.query(
      "SELECT * FROM wallets WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      [String(status).toUpperCase(), limit, offset]
    );
    return rows;
  } else {
    const [rows] = await db.query(
      "SELECT * FROM wallets ORDER BY id DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );
    return rows;
  }
}

/** Update status by wallet key */
async function updateWalletStatus({ key, status }) {
  const id = await resolveWalletNumericId({ key });
  if (!id) return null;

  await db.query("UPDATE wallets SET status = ? WHERE id = ?", [
    String(status).toUpperCase(),
    id,
  ]);

  const [rows] = await db.query("SELECT * FROM wallets WHERE id = ?", [id]);
  return rows[0] || null;
}

/** Delete wallet (only if no transactions exist) */
async function deleteWallet({ key }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const id = await resolveWalletNumericId({ key });
    if (!id) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const [[cnt]] = await conn.query(
      "SELECT COUNT(1) AS c FROM wallet_transactions WHERE tnx_from = ? OR tnx_to = ?",
      [id, id]
    );
    if (cnt.c > 0) {
      await conn.rollback();
      return { ok: false, code: "HAS_TRANSACTIONS" };
    }

    await conn.query("DELETE FROM wallets WHERE id = ?", [id]);
    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  createWallet,
  getWallet,
  listWallets,
  updateWalletStatus,
  deleteWallet,
};
