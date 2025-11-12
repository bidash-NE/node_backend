// models/salesModel.js
const db = require("../config/db");

/**
 * Get today's sales for a given business (merchant).
 * Includes only orders:
 *  - that contain items for this business_id
 *  - with status = 'COMPLETED'
 *  - created today (DATE(o.created_at) = CURDATE())
 *
 * We compute:
 *  - gross_sales: sum of (subtotal + delivery_fee) for that business
 *  - net_sales: gross minus proportional share of platform_fee
 *  - total_orders: number of distinct orders for this business today
 */
async function getTodaySalesForBusiness(business_id) {
  const bid = Number(business_id);
  if (!Number.isFinite(bid) || bid <= 0) {
    throw new Error("Invalid business_id");
  }

  const [rows] = await db.query(
    `
    SELECT
      o.order_id,
      o.total_amount,
      o.platform_fee,
      SUM(oi.subtotal + oi.delivery_fee) AS business_share
    FROM orders o
    JOIN order_items oi
      ON oi.order_id = o.order_id
    WHERE
      oi.business_id = ?
      AND o.status = 'COMPLETED'
      AND DATE(o.created_at) = CURDATE()
    GROUP BY
      o.order_id,
      o.total_amount,
      o.platform_fee
    `,
    [bid]
  );

  if (!rows.length) {
    return {
      business_id: bid,
      total_orders: 0,
      gross_sales: 0,
      net_sales: 0,
      currency: "Nu",
    };
  }

  let gross = 0;
  let net = 0;

  for (const row of rows) {
    const share = Number(row.business_share || 0); // this biz's revenue in that order
    const orderTotal = Number(row.total_amount || 0);
    const platformFee = Number(row.platform_fee || 0);

    gross += share;

    let feeShare = 0;
    if (orderTotal > 0 && platformFee > 0) {
      feeShare = platformFee * (share / orderTotal);
    }

    net += share - feeShare;
  }

  return {
    business_id: bid,
    total_orders: rows.length,
    gross_sales: Number(gross.toFixed(2)),
    net_sales: Number(net.toFixed(2)),
    currency: "Nu",
  };
}

module.exports = {
  getTodaySalesForBusiness,
};
