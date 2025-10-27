// controllers/idController.js
const db = require("../config/db");
const { makeTxnId, makeJournalCode } = require("../utils/idService");

/* Ensure uniqueness vs wallet_transactions */
async function ensureUnique(conn, sql, genFn) {
  while (true) {
    const v = genFn();
    const [rows] = await conn.query(sql, [v]);
    if (rows.length === 0) return v;
  }
}

/** POST /ids/transaction  { count?: number } -> { ok, data: [ids] } */
async function createTxnIdCtrl(req, res) {
  const count = Math.max(1, Math.min(100, Number(req.body?.count) || 1));
  try {
    const conn = await db.getConnection();
    try {
      const out = [];
      for (let i = 0; i < count; i++) {
        const id = await ensureUnique(
          conn,
          "SELECT 1 FROM wallet_transactions WHERE transaction_id = ? LIMIT 1",
          makeTxnId
        );
        out.push(id);
      }
      conn.release();
      return res.json({ ok: true, count, data: out });
    } catch (e) {
      conn.release();
      throw e;
    }
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}

/** POST /ids/journal  {} -> { ok, code } */
async function createJournalCodeCtrl(req, res) {
  try {
    const conn = await db.getConnection();
    try {
      const code = await ensureUnique(
        conn,
        "SELECT 1 FROM wallet_transactions WHERE journal_code = ? LIMIT 1",
        makeJournalCode
      );
      conn.release();
      return res.json({ ok: true, code });
    } catch (e) {
      conn.release();
      throw e;
    }
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}

/** POST /ids/both -> { ok, data: { transaction_ids:[id1,id2], journal_code } } */
async function createBothCtrl(req, res) {
  try {
    const conn = await db.getConnection();
    try {
      const journal_code = await ensureUnique(
        conn,
        "SELECT 1 FROM wallet_transactions WHERE journal_code = ? LIMIT 1",
        makeJournalCode
      );
      const t1 = await ensureUnique(
        conn,
        "SELECT 1 FROM wallet_transactions WHERE transaction_id = ? LIMIT 1",
        makeTxnId
      );
      const t2 = await ensureUnique(
        conn,
        "SELECT 1 FROM wallet_transactions WHERE transaction_id = ? LIMIT 1",
        makeTxnId
      );
      conn.release();
      return res.json({
        ok: true,
        data: { transaction_ids: [t1, t2], journal_code },
      });
    } catch (e) {
      conn.release();
      throw e;
    }
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
}

module.exports = { createTxnIdCtrl, createJournalCodeCtrl, createBothCtrl };
