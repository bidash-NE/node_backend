// models/walletModel.js
const db = require("../config/db");

const pad = (n, width = 6) => String(n).padStart(width, "0");
const makeWalletId = (numericId) => `NET${pad(numericId)}`;

async function userExists(conn, user_id) {
  const [rows] = await conn.query(
    "SELECT user_id FROM users WHERE user_id = ?",
    [user_id]
  );
  return rows.length > 0;
}

async function createWallet({ user_id, status = "ACTIVE" }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (!(await userExists(conn, user_id))) {
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

async function getWallet({ key }) {
  const [rows] = await db.query(
    /^NET/i.test(key)
      ? "SELECT * FROM wallets WHERE wallet_id = ?"
      : "SELECT * FROM wallets WHERE id = ?",
    [key]
  );
  return rows[0] || null;
}

// ✅ new
async function getWalletByUserId(user_id) {
  const [rows] = await db.query("SELECT * FROM wallets WHERE user_id = ?", [
    user_id,
  ]);
  return rows[0] || null;
}

async function listWallets({ limit = 50, offset = 0, status = null }) {
  limit = Math.min(Number(limit) || 50, 200);
  offset = Number(offset) || 0;

  if (status) {
    const [rows] = await db.query(
      "SELECT * FROM wallets WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      [String(status).toUpperCase(), limit, offset]
    );
    return rows;
  }
  const [rows] = await db.query(
    "SELECT * FROM wallets ORDER BY id DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
  return rows;
}

async function updateWalletStatus({ key, status }) {
  const [existing] = await db.query(
    /^NET/i.test(key)
      ? "SELECT id FROM wallets WHERE wallet_id = ?"
      : "SELECT id FROM wallets WHERE id = ?",
    [key]
  );
  if (!existing.length) return null;

  await db.query("UPDATE wallets SET status = ? WHERE id = ?", [
    status,
    existing[0].id,
  ]);
  const [rows] = await db.query("SELECT * FROM wallets WHERE id = ?", [
    existing[0].id,
  ]);
  return rows[0] || null;
}

async function deleteWallet({ key }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [wallet] = await conn.query(
      /^NET/i.test(key)
        ? "SELECT id FROM wallets WHERE wallet_id = ?"
        : "SELECT id FROM wallets WHERE id = ?",
      [key]
    );
    if (!wallet.length) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const id = wallet[0].id;
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
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
};
