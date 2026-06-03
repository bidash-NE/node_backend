// models/orders/crud/findAll.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: findAll(db)

const { prisma, parseDeliveryAddress } = require("../helpers");

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

/**
 * Compatible call styles:
 *
 * New:
 *   findAll()
 *
 * Old controller style:
 *   findAll(db)
 */
module.exports = async function findAll(_maybeDb = null) {
  const orders = await prisma.orders.findMany({
    orderBy: {
      created_at: "desc",
    },
  });

  if (!orders.length) return [];

  const ids = orders.map((o) => o.order_id);

  const items = await prisma.order_items.findMany({
    where: {
      order_id: {
        in: ids,
      },
    },
    orderBy: [
      {
        order_id: "asc",
      },
      {
        business_id: "asc",
      },
      {
        menu_id: "asc",
      },
    ],
  });

  const byOrder = new Map();

  const output = orders.map((order) => {
    const row = serializeRow(order);

    row.items = [];
    row.delivery_address = parseDeliveryAddress(row.delivery_address);

    byOrder.set(row.order_id, row);

    return row;
  });

  for (const item of items) {
    const row = serializeRow(item);
    byOrder.get(row.order_id)?.items.push(row);
  }

  return output;
};