// models/orders/crud/getOrderStatusCountsByBusiness.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call:
//    getOrderStatusCountsByBusiness(db, business_id)

const { prisma } = require("../helpers");

/* ---------------- helpers ---------------- */

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function normalizeStatus(status) {
  let key = String(status || "").trim().toUpperCase();

  if (key === "COMPLETED") {
    key = "DELIVERED";
  }

  return key;
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { start, end };
}

/**
 * Compatible call styles:
 *
 * New:
 *   getOrderStatusCountsByBusiness(business_id)
 *
 * Old controller style:
 *   getOrderStatusCountsByBusiness(db, business_id)
 */
module.exports = async function getOrderStatusCountsByBusiness(
  _maybeDbOrBusinessId,
  maybeBusinessId,
) {
  const rawBusinessId =
    maybeBusinessId !== undefined ? maybeBusinessId : _maybeDbOrBusinessId;

  const business_id = toInt(rawBusinessId);

  const allStatuses = [
    "PENDING",
    "CONFIRMED",
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    "REJECTED",
    "DECLINED",
  ];

  const result = {};

  for (const status of allStatuses) {
    result[status] = 0;
  }

  result.order_declined_today = 0;

  if (!business_id || business_id <= 0) {
    return result;
  }

  /*
    Old SQL:
    SELECT o.status, COUNT(DISTINCT o.order_id)
    FROM orders o
    INNER JOIN order_items oi ON oi.order_id = o.order_id
    WHERE oi.business_id = ?
    GROUP BY o.status

    Prisma equivalent:
    1. Find distinct order_ids from order_items for this business.
    2. Fetch those orders and count statuses in JS.

    This preserves COUNT(DISTINCT o.order_id).
  */
  const orderRefs = await prisma.order_items.findMany({
    where: {
      business_id,
    },
    select: {
      order_id: true,
    },
    distinct: ["order_id"],
  });

  const orderIds = orderRefs
    .map((x) => String(x.order_id || "").trim())
    .filter(Boolean);

  if (!orderIds.length) {
    return result;
  }

  const orders = await prisma.orders.findMany({
    where: {
      order_id: {
        in: orderIds,
      },
    },
    select: {
      order_id: true,
      status: true,
      created_at: true,
    },
  });

  for (const order of orders) {
    const key = normalizeStatus(order.status);

    if (!key) continue;

    if (result[key] === undefined) {
      result[key] = 0;
    }

    result[key] += 1;
  }

  const { start, end } = getTodayRange();

  result.order_declined_today = orders.filter((order) => {
    const status = normalizeStatus(order.status);

    if (status !== "DECLINED") {
      return false;
    }

    const createdAt = order.created_at ? new Date(order.created_at) : null;

    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return false;
    }

    return createdAt >= start && createdAt < end;
  }).length;

  return result;
};