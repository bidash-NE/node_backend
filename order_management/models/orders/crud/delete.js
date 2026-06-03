// models/orders/crud/delete.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: del(db, order_id)

const { prisma } = require("../helpers");

function normalizeOrderId(v) {
  return String(v || "").trim().toUpperCase();
}

/**
 * Compatible call styles:
 *
 * New:
 *   del(order_id)
 *
 * Old controller style:
 *   del(db, order_id)
 */
module.exports = async function del(_maybeDbOrOrderId, maybeOrderId) {
  const order_id = normalizeOrderId(maybeOrderId || _maybeDbOrOrderId);

  if (!order_id) {
    return 0;
  }

  const result = await prisma.orders.deleteMany({
    where: {
      order_id,
    },
  });

  return result.count || 0;
};