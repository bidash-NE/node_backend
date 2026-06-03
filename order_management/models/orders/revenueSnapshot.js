// models/orders/revenueSnapshot.js
// ✅ Full Prisma version based on your actual schema
// ✅ No raw db.query()
// ✅ Keeps same function names for compatibility

const { prisma } = require("../../lib/prisma");

/* ======================= HELPERS ======================= */

function getClient(client = null) {
  /*
    Supports:
    - normal prisma
    - Prisma transaction client

    If old MySQL conn is passed, it will be ignored and normal prisma is used.
  */
  if (
    client &&
    (typeof client.merchant_earnings?.findFirst === "function" ||
      typeof client.food_mart_revenue?.findFirst === "function")
  ) {
    return client;
  }

  return prisma;
}

function toBigIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
}

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeOwnerType(v) {
  const s = String(v || "FOOD").trim().toUpperCase();
  return s === "MART" ? "MART" : "FOOD";
}

function normalizeSource(v) {
  const s = String(v || "delivered").trim().toLowerCase();

  if (s === "orders") return "orders";
  if (s === "cancelled") return "cancelled";
  return "delivered";
}

/* ======================= MERCHANT EARNINGS ======================= */

async function insertMerchantEarningWithConn(
  conn,
  { business_id, order_id, total_amount, dateObj },
) {
  const tx = getClient(conn);

  const bid = toBigIntOrNull(business_id);
  const oid = toStrOrNull(order_id);

  if (!bid || !oid) {
    return;
  }

  const exists = await tx.merchant_earnings.findFirst({
    where: {
      order_id: oid,
      business_id: bid,
    },
    select: {
      id: true,
    },
  });

  if (exists) {
    return;
  }

  await tx.merchant_earnings.create({
    data: {
      business_id: bid,
      date: dateObj ? new Date(dateObj) : new Date(),
      total_amount: toNumber(total_amount, 0),
      order_id: oid,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });
}

/* ======================= FOOD / MART REVENUE ======================= */

async function insertFoodMartRevenueWithConn(conn, row = {}) {
  const tx = getClient(conn);

  const orderId = toStrOrNull(row.order_id);
  const userId = toIntOrNull(row.user_id);
  const businessId = toIntOrNull(row.business_id);

  if (!orderId || !userId || !businessId) {
    return;
  }

  const ownerType = normalizeOwnerType(row.owner_type);
  const source = normalizeSource(row.source);

  const data = {
    order_id: orderId,
    user_id: userId,
    business_id: businessId,
    owner_type: ownerType,
    source,

    status: row.status ? String(row.status) : null,
    placed_at: row.placed_at ? new Date(row.placed_at) : null,
    payment_method: row.payment_method ? String(row.payment_method) : null,

    total_amount: toNumber(row.total_amount, 0),
    platform_fee: toNumber(row.platform_fee, 0),
    revenue_earned: toNumber(row.revenue_earned, 0),
    tax: toNumber(row.tax, 0),

    customer_name: row.customer_name ? String(row.customer_name) : null,
    customer_phone: row.customer_phone ? String(row.customer_phone) : null,
    business_name: row.business_name ? String(row.business_name) : null,

    items_summary: row.items_summary ? String(row.items_summary) : null,
    total_quantity: Number.parseInt(row.total_quantity || 0, 10) || 0,
    details_json: row.details_json ? String(row.details_json) : null,
  };

  await tx.food_mart_revenue.upsert({
    where: {
      order_id: orderId,
    },
    create: {
      ...data,
      created_at: new Date(),
    },
    update: data,
  });
}

/* ======================= ITEM SUMMARY ======================= */

function buildItemsSummary(items = []) {
  const byName = new Map();
  let totalQty = 0;

  for (const it of items || []) {
    const name = String(it.item_name || "").trim() || "Item";
    const q = Number(it.quantity || 0) || 0;

    totalQty += q;
    byName.set(name, (byName.get(name) || 0) + q);
  }

  const summary = Array.from(byName.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, qty]) => `${name} x${qty}`)
    .join(", ");

  return {
    summary,
    totalQty,
  };
}

module.exports = {
  insertMerchantEarningWithConn,
  insertFoodMartRevenueWithConn,
  buildItemsSummary,
};