// models/ordersReportModel.js
const db = require("../config/db");

// Adjust these if your actual names differ:
const MERCHANT_TABLE = "merchant_business_details";
const OWNER_TYPE_COL = "owner_type";

// ✅ These 2 are important for your other tables
const CANCELLED_TIME_COL = "cancelled_at"; // in cancelled_orders
const DELIVERED_TIME_COL = "delivered_at"; // in delivered_orders

// ✅ NEW revenue snapshot table
const REVENUE_TABLE = "food_mart_revenue";

// Optional debug logs
const REPORT_DEBUG =
  String(process.env.REPORT_DEBUG || "").toLowerCase() === "true";

function dlog(enabled, ...args) {
  if (enabled) console.log(...args);
}

/* ========================= helpers ========================= */

async function tableExists(table) {
  const [rows] = await db.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     LIMIT 1
  `,
    [table],
  );
  return rows.length > 0;
}

async function getTableColumns(table) {
  const [rows] = await db.query(
    `
    SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
  `,
    [table],
  );
  return new Set(rows.map((r) => String(r.COLUMN_NAME)));
}

function safeParseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  const s = String(v).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* ============================================================
   ORDERS REPORT (UNCHANGED) — orders + cancelled + delivered
   ============================================================ */

/**
 * Builds "one row per order" report SQL for a given source table pair.
 */
function buildSourceReportSQL({
  sourceLabel,
  ordersTable,
  itemsTable,
  placedAtCol,
  statusFallback,
  ownerTypeNorm,
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit,
  offset,
}) {
  const where = [];
  const params = [];

  // owner type filter
  where.push(`LOWER(mbd.${OWNER_TYPE_COL}) = ?`);
  params.push(ownerTypeNorm);

  if (businessIds.length) {
    where.push(`ai_order.business_id IN (${businessIds.map(() => "?").join(",")})`);
    params.push(...businessIds);
  }

  if (userId) {
    where.push(`o.user_id = ?`);
    params.push(userId);
  }

  const statusExpr = statusFallback
    ? `COALESCE(o.status, '${statusFallback}')`
    : `o.status`;

  if (status) {
    where.push(`UPPER(${statusExpr}) = ?`);
    params.push(String(status).toUpperCase());
  }

  if (dateFrom) {
    where.push(`o.${placedAtCol} >= ?`);
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push(`o.${placedAtCol} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(`${dateTo} 00:00:00`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      '${sourceLabel}' AS source,
      o.order_id AS Order_ID,
      COALESCE(NULLIF(TRIM(u.user_name), ''), CONCAT('User ', o.user_id)) AS Customer_Name,
      COALESCE(
        NULLIF(TRIM(ai_order.business_name), ''),
        NULLIF(TRIM(mbd.business_name), ''),
        CONCAT('Business ', ai_order.business_id)
      ) AS Business_Name,
      ai_order.items_name AS Items_Name,
      ai_order.total_quantity AS Total_Quantity,
      COALESCE(o.total_amount, 0) AS Total_Amount,
      o.payment_method AS Payment,
      ${statusExpr} AS Status,
      o.${placedAtCol} AS Placed_At
    FROM \`${ordersTable}\` o
    JOIN (
      SELECT
        item_qty.order_id AS order_id,
        MAX(item_qty.business_id) AS business_id,
        MAX(item_qty.business_name) AS business_name,
        GROUP_CONCAT(
          CONCAT(item_qty.item_name, ' x', item_qty.qty)
          ORDER BY item_qty.item_name
          SEPARATOR ', '
        ) AS items_name,
        SUM(item_qty.qty) AS total_quantity
      FROM (
        SELECT
          i.order_id AS order_id,
          i.business_id AS business_id,
          i.business_name AS business_name,
          i.item_name AS item_name,
          SUM(i.quantity) AS qty
        FROM \`${itemsTable}\` i
        GROUP BY i.order_id, i.business_id, i.business_name, i.item_name
      ) item_qty
      GROUP BY item_qty.order_id
    ) ai_order ON ai_order.order_id = o.order_id
    LEFT JOIN users u ON u.user_id = o.user_id
    JOIN \`${MERCHANT_TABLE}\` mbd ON mbd.business_id = ai_order.business_id
    ${whereSql}
    ORDER BY o.${placedAtCol} DESC
    LIMIT ? OFFSET ?;
  `;

  const paramsWithLimit = [...params, Number(limit), Number(offset)];
  return { sql, params: paramsWithLimit };
}

async function runSource({
  debug,
  ownerTypeNorm,
  businessIds,
  userId,
  status,
  dateFrom,
  dateTo,
  limit,
  offset,
  sourceLabel,
  ordersTable,
  itemsTable,
  placedAtCol,
  statusFallback,
}) {
  const { sql, params } = buildSourceReportSQL({
    sourceLabel,
    ordersTable,
    itemsTable,
    placedAtCol,
    statusFallback,
    ownerTypeNorm,
    businessIds,
    userId,
    status,
    dateFrom,
    dateTo,
    limit,
    offset,
  });

  dlog(debug, `\n[REPORT] SOURCE=${sourceLabel}`);
  dlog(debug, sql);
  dlog(debug, params);

  const [rows] = await db.query(sql, params);

  return rows.map((r) => ({
    Order_ID: r.Order_ID,
    Customer_Name: r.Customer_Name,
    Business_Name: r.Business_Name,
    Items_Name: r.Items_Name,
    Total_Quantity: Number(r.Total_Quantity || 0),
    Total_Amount: Number(r.Total_Amount || 0),
    Payment: r.Payment,
    Status: r.Status,
    Placed_At: r.Placed_At,
    source: r.source,
  }));
}

async function fetchOrdersReportByOwnerType({
  ownerType,
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit = 100,
  offset = 0,
  debug = false,
}) {
  if (!ownerType) throw new Error("ownerType is required (food|mart)");
  const ownerTypeNorm = String(ownerType).toLowerCase().trim();
  if (!["food", "mart"].includes(ownerTypeNorm)) {
    throw new Error('ownerType must be "food" or "mart"');
  }

  const L = Math.min(Math.max(Number(limit), 1), 500);
  const O = Math.max(Number(offset), 0);

  const perSourceLimit = Math.min(5000, Math.max((L + O) * 30, 500));
  const perSourceOffset = 0;

  const dbg = Boolean(debug) || REPORT_DEBUG;

  const [ordersRows, cancelledRows, deliveredRows] = await Promise.all([
    runSource({
      debug: dbg,
      ownerTypeNorm,
      businessIds,
      userId,
      status,
      dateFrom,
      dateTo,
      limit: perSourceLimit,
      offset: perSourceOffset,
      sourceLabel: "orders",
      ordersTable: "orders",
      itemsTable: "order_items",
      placedAtCol: "created_at",
      statusFallback: null,
    }),
    runSource({
      debug: dbg,
      ownerTypeNorm,
      businessIds,
      userId,
      status,
      dateFrom,
      dateTo,
      limit: perSourceLimit,
      offset: perSourceOffset,
      sourceLabel: "cancelled",
      ordersTable: "cancelled_orders",
      itemsTable: "cancelled_order_items",
      placedAtCol: CANCELLED_TIME_COL,
      statusFallback: "CANCELLED",
    }),
    runSource({
      debug: dbg,
      ownerTypeNorm,
      businessIds,
      userId,
      status,
      dateFrom,
      dateTo,
      limit: perSourceLimit,
      offset: perSourceOffset,
      sourceLabel: "delivered",
      ordersTable: "delivered_orders",
      itemsTable: "delivered_order_items",
      placedAtCol: DELIVERED_TIME_COL,
      statusFallback: "DELIVERED",
    }),
  ]);

  const all = [...ordersRows, ...cancelledRows, ...deliveredRows].sort(
    (a, b) => {
      const ta = a.Placed_At ? new Date(a.Placed_At).getTime() : 0;
      const tb = b.Placed_At ? new Date(b.Placed_At).getTime() : 0;
      return tb - ta;
    },
  );

  const page = all.slice(O, O + L);
  return page.map(({ source, ...rest }) => rest);
}

/* ============================================================
   ✅ REVENUE REPORT (UPDATED) — reads from food_mart_revenue
   ============================================================ */

async function fetchFoodMartRevenueReport({
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit = 100,
  offset = 0,
  debug = false,
}) {
  const dbg = Boolean(debug) || REPORT_DEBUG;
  const L = Math.min(Math.max(Number(limit), 1), 500);
  const O = Math.max(Number(offset), 0);

  // If table not created yet, return empty (so API doesn't crash)
  const hasRevenueTable = await tableExists(REVENUE_TABLE);
  if (!hasRevenueTable) {
    dlog(dbg, `[REVENUE] Table ${REVENUE_TABLE} not found. Returning empty.`);
    return [];
  }

  const cols = await getTableColumns(REVENUE_TABLE);

  // Column helpers (robust if you rename later)
  const c = (name, fallbackSql = "NULL") => (cols.has(name) ? `r.\`${name}\`` : fallbackSql);

  // Prefer placed_at for date filtering; fallback to created_at
  const placedAtExpr = cols.has("placed_at")
    ? "r.`placed_at`"
    : cols.has("created_at")
      ? "r.`created_at`"
      : "NULL";

  const where = [];
  const params = [];

  // Only FOOD & MART rows
  if (cols.has("owner_type")) {
    where.push(`UPPER(r.\`owner_type\`) IN ('FOOD','MART')`);
  }

  if (businessIds.length && cols.has("business_id")) {
    where.push(`r.\`business_id\` IN (${businessIds.map(() => "?").join(",")})`);
    params.push(...businessIds);
  }

  if (userId && cols.has("user_id")) {
    where.push(`r.\`user_id\` = ?`);
    params.push(userId);
  }

  if (status && cols.has("status")) {
    where.push(`UPPER(r.\`status\`) = ?`);
    params.push(String(status).toUpperCase());
  }

  if (dateFrom && placedAtExpr !== "NULL") {
    where.push(`${placedAtExpr} >= ?`);
    params.push(`${dateFrom} 00:00:00`);
  }

  if (dateTo && placedAtExpr !== "NULL") {
    where.push(`${placedAtExpr} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(`${dateTo} 00:00:00`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Select a consistent response shape even if columns are missing
  const sql = `
    SELECT
      ${c("order_id", "r.\`order_id\`")} AS order_id,
      ${c("owner_type", "NULL")} AS owner_type,
      ${c("platform_fee", "0")} AS platform_fee,
      ${c("revenue_earned", c("platform_fee", "0"))} AS revenue_earned,
      ${c("total_amount", "0")} AS total_amount,
      ${c("details_json", "NULL")} AS details_json,
      ${placedAtExpr} AS placed_at
    FROM \`${REVENUE_TABLE}\` r
    ${whereSql}
    ORDER BY
      ${placedAtExpr !== "NULL" ? `${placedAtExpr} DESC` : "1"} ${
        cols.has("created_at") ? ", r.`created_at` DESC" : ""
      }
    LIMIT ? OFFSET ?;
  `;

  const paramsWithLimit = [...params, L, O];

  dlog(dbg, `\n[REVENUE] SQL:\n${sql}`);
  dlog(dbg, `[REVENUE] params:`, paramsWithLimit);

  const [rows] = await db.query(sql, paramsWithLimit);

  return rows.map((r) => {
    const ownerTypeLabel = String(r.owner_type || "").toUpperCase();
    const totalAmount = Number(r.total_amount || 0);
    const platformFee = Number(r.platform_fee || 0);
    const revenueEarned = Number(r.revenue_earned || 0);

    // details_json is your canonical payload; parse if possible
    let details = safeParseJson(r.details_json);

    // Fallback minimal details if details_json missing/broken
    if (!details) {
      details = {
        order: {
          id: r.order_id,
          status: status || null,
          placed_at: r.placed_at || null,
          owner_type: ownerTypeLabel || null,
          source: "food_mart_revenue",
        },
        amounts: {
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: revenueEarned,
          tax: 0,
        },
      };
    }

    return {
      order_id: r.order_id,
      owner_type: ownerTypeLabel,
      platform_fee: platformFee,
      revenue_earned: revenueEarned,
      total_amount: totalAmount,
      details,
    };
  });
}

module.exports = {
  fetchOrdersReportByOwnerType,
  fetchFoodMartRevenueReport,
};
