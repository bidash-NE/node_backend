// models/merchantEarningsModel.js
const db = require("../config/db");

async function tableExists(tableName) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [tableName],
  );
  return rows.length > 0;
}

function defaultRange() {
  // default: last 30 days including today
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);

  const toStr = to.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);
  return { from: fromStr, to: toStr };
}

function normalizeRange(from, to) {
  const def = defaultRange();
  const f = from || def.from;
  const t = to || def.to;

  // if swapped, fix
  if (f > t) return { from: t, to: f };
  return { from: f, to: t };
}

function buildGroupExpr(groupBy) {
  switch (groupBy) {
    case "week":
      // ISO-ish week key like 2026-04 (year-week)
      // mode 3 = Monday first, range 1-53, ISO week
      return {
        select: `CONCAT(YEAR(DATE_SUB(\`date\`, INTERVAL (DAYOFWEEK(\`date\`) + 5) % 7 DAY)), '-', LPAD(WEEK(\`date\`, 3), 2, '0'))`,
        label: "period",
        orderBy: "period",
      };
    case "month":
      return {
        select: `DATE_FORMAT(\`date\`, '%Y-%m')`,
        label: "period",
        orderBy: "period",
      };
    case "year":
      return {
        select: `CAST(YEAR(\`date\`) AS CHAR)`,
        label: "period",
        orderBy: "period",
      };
    case "day":
    default:
      return {
        select: `DATE(\`date\`)`,
        label: "period",
        orderBy: "period",
      };
  }
}

async function getEarningsByBusiness(business_id) {
  // If table doesn't exist, return empty
  const [t] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'merchant_earnings'
      LIMIT 1`,
  );
  if (!t.length) {
    return {
      summary: { total_amount: 0, orders_count: 0, rows_count: 0 },
      rows: [],
    };
  }

  // ✅ Return all earnings rows for the business (latest first)
  const [rows] = await db.query(
    `
    SELECT
      business_id,
      DATE(\`date\`) AS \`date\`,
      total_amount,
      order_id
    FROM merchant_earnings
    WHERE business_id = ?
    ORDER BY \`date\` DESC, order_id DESC
    `,
    [business_id],
  );

  const total_amount = rows.reduce(
    (s, r) => s + Number(r.total_amount || 0),
    0,
  );
  const orders_count = new Set(rows.map((r) => String(r.order_id))).size;

  return {
    summary: {
      total_amount: Number(total_amount.toFixed(2)),
      orders_count,
      rows_count: rows.length,
    },
    rows: rows.map((r) => ({
      business_id: Number(r.business_id),
      date: String(r.date),
      total_amount: Number(Number(r.total_amount || 0).toFixed(2)),
      order_id: String(r.order_id),
    })),
  };
}

module.exports = { getEarningsByBusiness };

module.exports = {
  getEarningsByBusiness,
};
