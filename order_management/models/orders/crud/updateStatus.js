// models/orders/crud/updateStatus.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call:
//    updateStatus(db, order_id, status, reason)

const { prisma } = require("../helpers");

/* ---------------- helpers ---------------- */

function normalizeOrderId(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeStatus(v) {
  let st = String(v || "").trim().toUpperCase();

  if (st === "COMPLETED") {
    st = "DELIVERED";
  }

  return st;
}

function normalizeReason(v) {
  return String(v || "").trim();
}

/**
 * Compatible call styles:
 *
 * New:
 *   updateStatus(order_id, status, reason)
 *
 * Old controller style:
 *   updateStatus(db, order_id, status, reason)
 */
module.exports = async function updateStatus(
  _maybeDbOrOrderId,
  maybeOrderIdOrStatus,
  maybeStatusOrReason,
  maybeReason,
) {
  const usingOldDbArg =
    _maybeDbOrOrderId && typeof _maybeDbOrOrderId.query === "function";

  const order_id = normalizeOrderId(
    usingOldDbArg ? maybeOrderIdOrStatus : _maybeDbOrOrderId,
  );

  const status = usingOldDbArg ? maybeStatusOrReason : maybeOrderIdOrStatus;
  const reason = usingOldDbArg ? maybeReason : maybeStatusOrReason;

  if (!order_id) {
    return 0;
  }

  const st = normalizeStatus(status);

  if (!st) {
    return 0;
  }

  const result = await prisma.orders.updateMany({
    where: {
      order_id,
    },
    data: {
      status: st,
      status_reason: normalizeReason(reason),
      updated_at: new Date(),
    },
  });

  return result.count || 0;
};