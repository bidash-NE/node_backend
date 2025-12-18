// models/ordersReportModel.js
const db = require("../config/db");

// Adjust these if your actual names differ:
const MERCHANT_TABLE = "merchant_business_details";
const OWNER_TYPE_COL = "owner_type";

// ✅ These 2 are important for your other tables
const CANCELLED_TIME_COL = "cancelled_at"; // in cancelled_orders
const DELIVERED_TIME_COL = "delivered_at"; // change to "created_at" if your delivered_orders doesn't have delivered_at

// Optional debug logs
const REPORT_DEBUG =
  String(process.env.REPORT_DEBUG || "").toLowerCase() === "true";

function dlog(enabled, ...args) {
  if (enabled) console.log(...args);
}

/**
 * Builds "one row per order" report SQL for a given source table pair.
 * ✅ MariaDB/MySQL safe:
 * - NO ANY_VALUE()
 * - NO SUM() inside GROUP_CONCAT()
 * - Outer query has NO GROUP BY on strings -> avoids collation aggregate issues
 */
function buildSourceReportSQL({
  sourceLabel, // 'orders' | 'cancelled' | 'delivered' (for debugging)
  ordersTable,
  itemsTable,
  placedAtCol, // created_at / cancelled_at / delivered_at
  statusFallback, // e.g. 'CANCELLED' / 'DELIVERED' / null
  ownerTypeNorm, // 'food' | 'mart' (required)
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

  // business filter (based on aggregated business_id per order)
  if (businessIds.length) {
    where.push(
      `ai_order.business_id IN (${businessIds.map(() => "?").join(",")})`
    );
    params.push(...businessIds);
  }

  if (userId) {
    where.push(`o.user_id = ?`);
    params.push(userId);
  }

  // status expression (supports fallback for cancelled/delivered)
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

  // ✅ 2-level aggregation:
  // item_qty: per (order_id, item_name) => qty
  // ai_order: per order_id => items list + total qty + (single) business id/name
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
    // keep for debugging if needed
    source: r.source,
  }));
}

/**
 * ✅ UPDATED: Returns merged data from:
 * - orders + order_items
 * - cancelled_orders + cancelled_order_items
 * - delivered_orders + delivered_order_items
 *
 * Still filters by owner type via merchant_business_details.owner_type.
 *
 * IMPORTANT:
 * - We OVERFETCH per source then merge+sort then apply final limit/offset
 *   so cancelled/delivered rows can appear even when orders has many rows.
 */
async function fetchOrdersReportByOwnerType({
  ownerType, // 'food' | 'mart' (required)
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

  // ✅ overfetch so other tables are not "hidden" behind orders pagination
  const perSourceLimit = Math.min(5000, Math.max((L + O) * 30, 500));
  const perSourceOffset = 0; // we paginate after merge

  const dbg = Boolean(debug) || REPORT_DEBUG;

  dlog(
    dbg,
    `\n[REPORT] START ownerType=${ownerTypeNorm} limit=${L} offset=${O} perSourceLimit=${perSourceLimit}`
  );

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
      placedAtCol: DELIVERED_TIME_COL, // change if needed
      statusFallback: "DELIVERED",
    }),
  ]);

  dlog(
    dbg,
    `[REPORT] counts: orders=${ordersRows.length}, cancelled=${cancelledRows.length}, delivered=${deliveredRows.length}`
  );

  // merge + sort newest first
  const all = [...ordersRows, ...cancelledRows, ...deliveredRows].sort(
    (a, b) => {
      const ta = a.Placed_At ? new Date(a.Placed_At).getTime() : 0;
      const tb = b.Placed_At ? new Date(b.Placed_At).getTime() : 0;
      return tb - ta;
    }
  );

  // final pagination
  const page = all.slice(O, O + L);

  dlog(dbg, `[REPORT] FINAL merged=${all.length}, page=${page.length}`);
  if (dbg)
    dlog(
      dbg,
      `[REPORT] page sources:`,
      page.map((x) => ({ id: x.Order_ID, src: x.source, dt: x.Placed_At }))
    );

  // Return same shape as before (controller uses rows.length)
  // If you want to hide "source", remove it in map above.
  return page.map(({ source, ...rest }) => rest);
}

/**
 * ✅ Keep your revenue report as-is (still based on orders table).
 * If you want revenue including delivered/cancelled tables too, tell me and I’ll update it.
 */
async function fetchFoodMartRevenueReport({
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit = 100,
  offset = 0,
  debug = false, // optional (if you want logs)
}) {
  const REPORT_DEBUG =
    Boolean(debug) ||
    String(process.env.REPORT_DEBUG || "").toLowerCase() === "true";

  const dlog = (...args) => {
    if (REPORT_DEBUG) console.log(...args);
  };

  const L = Math.min(Math.max(Number(limit), 1), 500);
  const O = Math.max(Number(offset), 0);

  // overfetch per source then paginate after merge
  const perSourceLimit = Math.min(5000, Math.max((L + O) * 30, 500));
  const perSourceOffset = 0;

  // helper to build where + params
  function buildWhereForRevenue({ placedAtCol, statusExpr }) {
    const where = [];
    const params = [];

    // only food & mart businesses
    where.push(`LOWER(mbd.${OWNER_TYPE_COL}) IN ('food','mart')`);

    if (businessIds.length) {
      where.push(
        `ai_order.business_id IN (${businessIds.map(() => "?").join(",")})`
      );
      params.push(...businessIds);
    }
    if (userId) {
      where.push(`o.user_id = ?`);
      params.push(userId);
    }
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

    return {
      whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
      params,
    };
  }

  // ✅ One source runner (orders/cancelled/delivered)
  async function runRevenueSource({
    sourceLabel,
    ordersTable,
    itemsTable,
    placedAtCol, // created_at / cancelled_at / delivered_at
    ownerTypeFallback, // optional if table doesn't store owner_type (we still derive from mbd)
    statusFallback, // e.g. 'CANCELLED', 'DELIVERED'
    platformFeeCol, // platform_fee if exists in that table, else null
  }) {
    // status expression with fallback for cancelled/delivered
    const statusExpr = statusFallback
      ? `COALESCE(o.status, '${statusFallback}')`
      : `o.status`;

    const platformExpr = platformFeeCol
      ? `COALESCE(o.${platformFeeCol}, 0)`
      : `0`;

    const { whereSql, params } = buildWhereForRevenue({
      placedAtCol,
      statusExpr,
    });

    // ✅ Two-level item aggregation (same pattern you used for orders report)
    const sql = `
      SELECT
        '${sourceLabel}' AS source,
        o.order_id AS order_id,
        o.user_id AS user_id,
        LOWER(mbd.${OWNER_TYPE_COL}) AS owner_type,

        COALESCE(NULLIF(TRIM(u.user_name), ''), CONCAT('User ', o.user_id)) AS customer_name,
        u.phone AS customer_phone,

        ai_order.business_id AS business_id,
        COALESCE(NULLIF(TRIM(ai_order.business_name), ''), NULLIF(TRIM(mbd.business_name), '')) AS business_name,

        ai_order.items_name AS items_name,
        ai_order.total_quantity AS total_quantity,

        COALESCE(o.total_amount, 0) AS total_amount,
        ${platformExpr} AS platform_fee,   -- admin platform fee
        ${platformExpr} AS revenue_earned, -- revenue == platform fee

        o.payment_method AS payment_method,
        ${statusExpr} AS status,
        o.${placedAtCol} AS placed_at

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

      JOIN \`${MERCHANT_TABLE}\` mbd ON mbd.business_id = ai_order.business_id
      LEFT JOIN users u ON u.user_id = o.user_id

      ${whereSql}
      ORDER BY o.${placedAtCol} DESC
      LIMIT ? OFFSET ?;
    `;

    const paramsWithLimit = [
      ...params,
      Number(perSourceLimit),
      Number(perSourceOffset),
    ];

    dlog(`\n[REVENUE] SOURCE=${sourceLabel}`);
    dlog(sql);
    dlog(paramsWithLimit);

    const [rows] = await db.query(sql, paramsWithLimit);

    return rows.map((r) => {
      const ownerTypeLabel = String(r.owner_type || "").toUpperCase(); // FOOD / MART

      const totalAmount = Number(r.total_amount || 0);
      const platformFee = Number(r.platform_fee || 0);
      const revenueEarned = Number(r.revenue_earned || 0);

      const details = {
        order: {
          id: r.order_id,
          status: r.status,
          placed_at: r.placed_at,
          owner_type: ownerTypeLabel,
          source: r.source, // orders/cancelled/delivered (handy)
        },
        customer: {
          id: r.user_id,
          name: r.customer_name,
          phone: r.customer_phone || null,
        },
        business: {
          id: r.business_id,
          name: r.business_name,
          owner_type: ownerTypeLabel,
        },
        items: {
          summary: r.items_name || "",
          total_quantity: Number(r.total_quantity || 0),
        },
        amounts: {
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: revenueEarned,
          tax: 0,
        },
        payment: {
          method: r.payment_method,
        },
      };

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

  // ✅ If your delivered table uses created_at, change here:
  const deliveredPlacedAt = "delivered_at"; // or "created_at"
  const cancelledPlacedAt = "cancelled_at"; // or "created_at" if your schema differs

  // ✅ Run 3 sources (in parallel)
  const [ordersRows, cancelledRows, deliveredRows] = await Promise.all([
    runRevenueSource({
      sourceLabel: "orders",
      ordersTable: "orders",
      itemsTable: "order_items",
      placedAtCol: "created_at",
      statusFallback: null,
      platformFeeCol: "platform_fee", // exists in orders
    }),
    runRevenueSource({
      sourceLabel: "cancelled",
      ordersTable: "cancelled_orders",
      itemsTable: "cancelled_order_items",
      placedAtCol: cancelledPlacedAt,
      statusFallback: "CANCELLED",
      platformFeeCol: "platform_fee", // if NOT present in cancelled_orders, set null
    }),
    runRevenueSource({
      sourceLabel: "delivered",
      ordersTable: "delivered_orders",
      itemsTable: "delivered_order_items",
      placedAtCol: deliveredPlacedAt,
      statusFallback: "DELIVERED",
      platformFeeCol: "platform_fee", // if NOT present in delivered_orders, set null
    }),
  ]);

  dlog(
    `[REVENUE] counts: orders=${ordersRows.length}, cancelled=${cancelledRows.length}, delivered=${deliveredRows.length}`
  );

  // merge + sort newest first
  const all = [...ordersRows, ...cancelledRows, ...deliveredRows].sort(
    (a, b) => {
      const ta = a?.details?.order?.placed_at
        ? new Date(a.details.order.placed_at).getTime()
        : 0;
      const tb = b?.details?.order?.placed_at
        ? new Date(b.details.order.placed_at).getTime()
        : 0;
      return tb - ta;
    }
  );

  // final pagination
  const page = all.slice(O, O + L);
  return page;
}

module.exports = {
  fetchOrdersReportByOwnerType,
  fetchFoodMartRevenueReport,
};
