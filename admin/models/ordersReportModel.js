// models/ordersReportModel.js
const db = require("../config/db");

// Adjust these if your actual names differ:
const MERCHANT_TABLE = "merchant_business_details"; // <-- your real table name
const OWNER_TYPE_COL = "owner_type"; // <-- change if it's 'type'/'ownerType'

/**
 * Returns one row per order with item names + quantities merged.
 * Filters by owner type from merchant_business_details (food|mart).
 */
async function fetchOrdersReportByOwnerType({
  ownerType, // 'food' | 'mart' (required)
  businessIds = [], // optional: restrict to certain business_ids
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
    JOIN \`${MERCHANT_TABLE}\` mbd ON mbd.business_id = ai.business_id  -- << using merchant_business_details
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
    Payment: r.Payment, // 'COD' | 'Wallet' | 'Card'
    Status: r.Status, // 'PENDING' | 'CONFIRMED' | ...
    Placed_At: r.Placed_At, // DATETIME
  }));
}

module.exports = { fetchOrdersReportByOwnerType };
