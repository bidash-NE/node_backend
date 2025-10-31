// models/transactionHistoryModel.js
const db = require("../config/db");

const WALLET_RE = /^NET\d{6,}$/i;
const isValidWalletId = (id) => WALLET_RE.test(String(id || "").trim());

function encodeCursor(created_at, id) {
  const ts =
    created_at instanceof Date
      ? created_at.toISOString()
      : new Date(created_at).toISOString();
  return Buffer.from(`${ts}|${id}`).toString("base64");
}
function decodeCursor(cursor) {
  try {
    const [ts, idStr] = Buffer.from(String(cursor), "base64")
      .toString("utf8")
      .split("|");
    const id = Number(idStr);
    const d = new Date(ts);
    if (!isFinite(d.getTime()) || !Number.isInteger(id)) return null;
    return { ts: d, id };
  } catch {
    return null;
  }
}

function buildCommonFilters({ start, end, journal, q }) {
  const where = [],
    params = [];
  if (start) {
    where.push("wt.created_at >= ?");
    params.push(new Date(start));
  }
  if (end) {
    where.push("wt.created_at <= ?");
    params.push(new Date(end));
  }
  if (journal) {
    where.push("wt.journal_code = ?");
    params.push(journal);
  }
  if (q) {
    where.push(
      "(wt.transaction_id = ? OR wt.note LIKE ? OR wt.tnx_from = ? OR wt.tnx_to = ?)"
    );
    params.push(q, `%${q}%`, q, q);
  }
  return { where, params };
}

async function listByWallet(
  wallet_id,
  {
    limit = 50,
    cursor = null,
    start = null,
    end = null,
    direction = null, // 'CR' or 'DR' or null
    journal = null,
    q = null,
  } = {}
) {
  if (!isValidWalletId(wallet_id)) return { rows: [], next_cursor: null };

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

  // Reuse your common filters (dates, journal, query text, etc.)
  const { where, params } = buildCommonFilters({ start, end, journal, q });

  // ✅ Core change: single-side filter using generated column
  where.push("wt.actual_wallet_id = ?");
  params.push(wallet_id);

  // Optional one-sided direction filter using remark (CR/DR)
  if (direction === "CR" || direction === "DR") {
    where.push("wt.remark = ?");
    params.push(direction);
  }

  // Cursor pagination (stable, same as before)
  let cursorClause = "";
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c) {
      cursorClause =
        " AND (wt.created_at < ? OR (wt.created_at = ? AND wt.id < ?))";
      params.push(c.ts, c.ts, c.id);
    }
  }

  const sql = `
    SELECT
      wt.id,
      wt.transaction_id,
      wt.journal_code,
      wt.tnx_from,
      wt.tnx_to,
      wt.actual_wallet_id,   -- for debugging/inspection if needed
      wt.amount,
      wt.remark,             -- 'CR' or 'DR' (your direction)
      wt.note,
      wt.created_at
    FROM wallet_transactions wt
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ${cursorClause}
    ORDER BY wt.created_at DESC, wt.id DESC
    LIMIT ?
  `;

  const [rows] = await db.query(sql, [...params, lim + 1]);

  let next_cursor = null;
  if (rows.length > lim) {
    const last = rows[lim - 1];
    next_cursor = encodeCursor(last.created_at, last.id);
    rows.length = lim;
  }

  return { rows, next_cursor };
}

async function listByUser(user_id, opts = {}) {
  const [[w]] = await db.query(
    `SELECT wallet_id FROM wallets WHERE user_id = ?`,
    [user_id]
  );
  if (!w) return { rows: [], next_cursor: null, wallet_id: null };
  const wallet_id = w.wallet_id;
  const result = await listByWallet(wallet_id, opts);
  return { ...result, wallet_id };
}

async function listAll({
  limit = 100,
  cursor = null,
  start = null,
  end = null,
  journal = null,
  q = null,
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const { where, params } = buildCommonFilters({ start, end, journal, q });

  let cursorClause = "";
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c) {
      cursorClause =
        " AND (wt.created_at < ? OR (wt.created_at = ? AND wt.id < ?))";
      params.push(c.ts, c.ts, c.id);
    }
  }

  const sql = `
    SELECT wt.id, wt.transaction_id, wt.journal_code,
           wt.tnx_from, wt.tnx_to, wt.amount, wt.remark, wt.note, wt.created_at
    FROM wallet_transactions wt
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ${cursorClause}
    ORDER BY wt.created_at DESC, wt.id DESC
    LIMIT ?
  `;
  const [rows] = await db.query(sql, [...params, lim + 1]);
  let next_cursor = null;
  if (rows.length > lim) {
    const last = rows[lim - 1];
    next_cursor = encodeCursor(last.created_at, last.id);
    rows.length = lim;
  }
  return { rows, next_cursor };
}

module.exports = { listByWallet, listByUser, listAll, isValidWalletId };
