// models/walletModel.js
const db = require("../config/db");

/**
 * Wallet ID format:
 *  - "TD" + 8 random digits
 *  - Example: TD12345678
 * Must be UNIQUE.
 */

function randDigits(len = 8) {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function makeWalletId(prefix = "TD") {
  return `${prefix}${randDigits(8)}`;
}

async function userExists(conn, user_id) {
  const [rows] = await conn.query(
    "SELECT user_id FROM users WHERE user_id = ?",
    [user_id],
  );
  return rows.length > 0;
}

async function walletIdExists(conn, wallet_id) {
  const [rows] = await conn.query(
    "SELECT 1 FROM wallets WHERE wallet_id = ? LIMIT 1",
    [wallet_id],
  );
  return rows.length > 0;
}

async function generateUniqueWalletId(conn, prefix = "TD", maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const candidate = makeWalletId(prefix);
    const exists = await walletIdExists(conn, candidate);
    if (!exists) return candidate;
  }
  throw new Error("Failed to generate unique wallet_id. Please retry.");
}

function isWalletId(v) {
  return /^TD\d{8}$/i.test(String(v || "").trim());
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
      [user_id],
    );
    if (existing.length) {
      await conn.rollback();
      return { error: "WALLET_EXISTS", wallet: existing[0] };
    }

    let insertedId = null;
    let wallet_id = null;

    for (let attempt = 0; attempt < 50; attempt++) {
      wallet_id = await generateUniqueWalletId(conn, "TD", 10);

      try {
        const [ins] = await conn.query(
          "INSERT INTO wallets (wallet_id, user_id, amount, status) VALUES (?, ?, 0.00, ?)",
          [wallet_id, user_id, status],
        );
        insertedId = ins.insertId;
        break;
      } catch (err) {
        if (
          err &&
          (err.code === "ER_DUP_ENTRY" ||
            String(err.message || "").includes("Duplicate"))
        ) {
          wallet_id = null;
          continue;
        }
        throw err;
      }
    }

    if (!insertedId || !wallet_id) {
      throw new Error(
        "Could not allocate unique wallet_id after multiple attempts.",
      );
    }

    const [[row]] = await conn.query("SELECT * FROM wallets WHERE id = ?", [
      insertedId,
    ]);

    await conn.commit();
    return row;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

async function getWallet({ key }) {
  const k = String(key).trim();
  const byWalletId = isWalletId(k);

  const [rows] = await db.query(
    byWalletId
      ? "SELECT * FROM wallets WHERE wallet_id = ?"
      : "SELECT * FROM wallets WHERE id = ?",
    [byWalletId ? k : Number(k)],
  );
  return rows[0] || null;
}

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
      [String(status).toUpperCase(), limit, offset],
    );
    return rows;
  }
  const [rows] = await db.query(
    "SELECT * FROM wallets ORDER BY id DESC LIMIT ? OFFSET ?",
    [limit, offset],
  );
  return rows;
}

async function updateWalletStatus({ key, status }) {
  const k = String(key).trim();
  const byWalletId = isWalletId(k);

  const [existing] = await db.query(
    byWalletId
      ? "SELECT id FROM wallets WHERE wallet_id = ?"
      : "SELECT id FROM wallets WHERE id = ?",
    [byWalletId ? k : Number(k)],
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

    const k = String(key).trim();
    const byWalletId = isWalletId(k);

    const [wallet] = await conn.query(
      byWalletId
        ? "SELECT id, wallet_id FROM wallets WHERE wallet_id = ?"
        : "SELECT id, wallet_id FROM wallets WHERE id = ?",
      [byWalletId ? k : Number(k)],
    );

    if (!wallet.length) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const id = wallet[0].id;
    const wid = wallet[0].wallet_id;

    const [[cnt]] = await conn.query(
      "SELECT COUNT(1) AS c FROM wallet_transactions WHERE tnx_from = ? OR tnx_to = ?",
      [wid, wid],
    );

    if (cnt.c > 0) {
      await conn.rollback();
      return { ok: false, code: "HAS_TRANSACTIONS" };
    }

    await conn.query("DELETE FROM wallets WHERE id = ?", [id]);
    await conn.commit();
    return { ok: true };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Set / update encrypted T-PIN for a wallet
 */
async function setWalletTPin({ key, t_pin_hash }) {
  const k = String(key).trim();
  const byWalletId = isWalletId(k);

  const [existing] = await db.query(
    byWalletId
      ? "SELECT id FROM wallets WHERE wallet_id = ?"
      : "SELECT id FROM wallets WHERE id = ?",
    [byWalletId ? k : Number(k)],
  );
  if (!existing.length) return null;

  const walletDbId = existing[0].id;

  await db.query("UPDATE wallets SET t_pin = ? WHERE id = ?", [
    t_pin_hash,
    walletDbId,
  ]);

  const [rows] = await db.query("SELECT * FROM wallets WHERE id = ?", [
    walletDbId,
  ]);
  return rows[0] || null;
}

module.exports = {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
  setWalletTPin,
};
