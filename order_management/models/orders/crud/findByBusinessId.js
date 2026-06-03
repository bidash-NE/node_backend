// models/orders/crud/findByBusinessId.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: findByBusinessId(db, business_id)

const { prisma } = require("../helpers");

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

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
 *   findByBusinessId(business_id)
 *
 * Old controller style:
 *   findByBusinessId(db, business_id)
 */
module.exports = async function findByBusinessId(
  _maybeDbOrBusinessId,
  maybeBusinessId,
) {
  const rawBusinessId =
    maybeBusinessId !== undefined ? maybeBusinessId : _maybeDbOrBusinessId;

  const business_id = toInt(rawBusinessId);

  if (!business_id || business_id <= 0) {
    return [];
  }

  const items = await prisma.order_items.findMany({
    where: {
      business_id,
    },
    orderBy: [
      {
        order_id: "desc",
      },
      {
        menu_id: "asc",
      },
    ],
  });

  return items.map(serializeRow);
};