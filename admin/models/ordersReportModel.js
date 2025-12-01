// models/ordersReportModel.js
const db = require("../config/db");

// Adjust these if your actual names differ:
const MERCHANT_TABLE = "merchant_business_details";
const OWNER_TYPE_COL = "owner_type";

/**
 * Returns one row per order with item names + quantities merged.
 * Filters by owner type from merchant_business_details (food|mart).
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
}) {
  if (!ownerType) throw new Error("ownerType is required (food|mart)");
  const ownerTypeNorm = String(ownerType).toLowerCase().trim();
  if (!["food", "mart"].includes(ownerTypeNorm)) {
    throw new Error('ownerType must be "food" or "mart"');
  }

  const where = [];
  const params = [];

  // Owner type (case-insensitive)
  where.push(`LOWER(mbd.${OWNER_TYPE_COL}) = ?`);
  params.push(ownerTypeNorm);

  if (businessIds.length) {
    where.push(`ai.business_id IN (${businessIds.map(() => "?").join(",")})`);
    params.push(...businessIds);
  }
  if (userId) {
    where.push("o.user_id = ?");
    params.push(userId);
  }
  if (status) {
    where.push("o.status = ?");
    params.push(status.toUpperCase());
  }
  if (dateFrom) {
    where.push("o.created_at >= ?");
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push("o.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${dateTo} 00:00:00`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      o.order_id AS Order_ID,
      COALESCE(NULLIF(TRIM(MAX(u.user_name)), ''), CONCAT('User ', o.user_id)) AS Customer_Name,
      MAX(ai.business_name) AS Business_Name,
      GROUP_CONCAT(CONCAT(ai.item_name, ' x', ai.qty) ORDER BY ai.item_name SEPARATOR ', ') AS Items_Name,
      SUM(ai.qty) AS Total_Quantity,
      o.total_amount AS Total_Amount,
      o.payment_method AS Payment,
      o.status AS Status,
      o.created_at AS Placed_At
    FROM orders o
    JOIN (
      SELECT
        order_id,
        business_id,
        business_name,
        item_name,
        SUM(quantity) AS qty
      FROM order_items
      GROUP BY order_id, business_id, business_name, item_name
    ) ai ON ai.order_id = o.order_id
    LEFT JOIN users u ON u.user_id = o.user_id
    JOIN \`${MERCHANT_TABLE}\` mbd ON mbd.business_id = ai.business_id
    ${whereSql}
    GROUP BY o.order_id
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?;
  `;

  const paramsWithLimit = [...params, Number(limit), Number(offset)];
  const [rows] = await db.query(sql, paramsWithLimit);

  return rows.map((r) => ({
    Order_ID: r.Order_ID,
    Customer_Name: r.Customer_Name,
    Business_Name: r.Business_Name,
    Items_Name: r.Items_Name, // "Pizza x2, Burger x1"
    Total_Quantity: Number(r.Total_Quantity),
    Total_Amount: Number(r.Total_Amount),
    Payment: r.Payment,
    Status: r.Status,
    Placed_At: r.Placed_At,
  }));
}

/**
 * Combined FOOD + MART revenue report (ADMIN revenue).
 * Returns one row per order with:
 * - order_id
 * - owner_type (FOOD / MART)
 * - platform_fee
 * - revenue_earned (== platform_fee)
 * - total_amount
 * - details: full structured JSON including status
 */
async function fetchFoodMartRevenueReport({
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit = 100,
  offset = 0,
}) {
  const where = [];
  const params = [];

  // only food & mart businesses
  where.push(`LOWER(mbd.${OWNER_TYPE_COL}) IN ('food','mart')`);

  if (businessIds.length) {
    where.push(`ai.business_id IN (${businessIds.map(() => "?").join(",")})`);
    params.push(...businessIds);
  }
  if (userId) {
    where.push("o.user_id = ?");
    params.push(userId);
  }
  if (status) {
    where.push("o.status = ?");
    params.push(status.toUpperCase());
  }
  if (dateFrom) {
    where.push("o.created_at >= ?");
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push("o.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${dateTo} 00:00:00`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      o.order_id AS order_id,
      o.user_id AS user_id,
      LOWER(mbd.${OWNER_TYPE_COL}) AS owner_type,
      COALESCE(NULLIF(TRIM(MAX(u.user_name)), ''), CONCAT('User ', o.user_id)) AS customer_name,
      MAX(u.phone) AS customer_phone,
      MAX(ai.business_id) AS business_id,
      MAX(ai.business_name) AS business_name,
      GROUP_CONCAT(CONCAT(ai.item_name, ' x', ai.qty) ORDER BY ai.item_name SEPARATOR ', ') AS items_name,
      SUM(ai.qty) AS total_quantity,
      o.total_amount AS total_amount,
      o.platform_fee AS platform_fee,      -- admin platform fee
      o.payment_method AS payment_method,
      o.status AS status,
      o.created_at AS placed_at
    FROM orders o
    JOIN (
      SELECT
        order_id,
        business_id,
        business_name,
        item_name,
        SUM(quantity) AS qty
      FROM order_items
      GROUP BY order_id, business_id, business_name, item_name
    ) ai ON ai.order_id = o.order_id
    LEFT JOIN users u ON u.user_id = o.user_id
    JOIN \`${MERCHANT_TABLE}\` mbd ON mbd.business_id = ai.business_id
    ${whereSql}
    GROUP BY o.order_id, owner_type
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?;
  `;

  const paramsWithLimit = [...params, Number(limit), Number(offset)];
  const [rows] = await db.query(sql, paramsWithLimit);

  return rows.map((r) => {
    const totalAmount = Number(r.total_amount || 0);
    const platformFee = Number(r.platform_fee || 0);
    const ownerTypeLabel = String(r.owner_type || "").toUpperCase(); // FOOD / MART

    // ADMIN revenue = platform fee
    const revenueEarned = platformFee;

    const totalQty = Number(r.total_quantity || 0);
    const itemsSummary = r.items_name || "";

    const details = {
      order: {
        id: r.order_id,
        status: r.status, // includes status
        placed_at: r.placed_at,
        owner_type: ownerTypeLabel,
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
        summary: itemsSummary, // "Pizza x2, Burger x1"
        total_quantity: totalQty,
      },
      amounts: {
        total_amount: totalAmount,
        platform_fee: platformFee,
        revenue_earned: revenueEarned, // == platform_fee
        tax: 0, // no tax for food & mart
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

module.exports = {
  fetchOrdersReportByOwnerType,
  fetchFoodMartRevenueReport,
};
