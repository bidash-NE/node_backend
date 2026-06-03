// models/orders/pointsEngine.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps same exported function names for compatibility

const { prisma } = require("../../lib/prisma");
const { insertUserNotification } = require("./orderNotifications");

const fmtNu = (n) => Number(n || 0).toFixed(2);

/* ======================= helpers ======================= */

function getClient(client = null) {
  // Accept prisma transaction client if passed.
  // If old MySQL conn is passed, ignore it and use prisma.
  if (client && typeof client.point_system?.findFirst === "function") {
    return client;
  }

  return prisma;
}

function normalizeOrderId(order_id) {
  return String(order_id || "").trim().toUpperCase();
}

function normalizeStatus(status) {
  const s = String(status || "").trim().toUpperCase();
  return s === "COMPLETED" ? "DELIVERED" : s;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ======================= core queries ======================= */

async function getActivePointRule(client = null) {
  const tx = getClient(client);

  const row = await tx.point_system.findFirst({
    where: {
      is_active: true,
    },
    orderBy: {
      created_at: "desc",
    },
    select: {
      point_id: true,
      min_amount_per_point: true,
      point_to_award: true,
      is_active: true,
    },
  });

  return row || null;
}

async function hasPointsAwardNotification(order_id, client = null) {
  const tx = getClient(client);
  const oid = normalizeOrderId(order_id);

  if (!oid) return false;

  /*
    Old SQL used:
    JSON_EXTRACT(data, '$.order_id') = ?

    Because notifications.data is usually stored as string JSON,
    Prisma cannot reliably JSON_EXTRACT on MySQL string columns without raw SQL.

    Safer Prisma approach:
    fetch recent points_awarded notifications and check JSON in JS.
  */
  const rows = await tx.notifications.findMany({
    where: {
      type: "points_awarded",
    },
    select: {
      data: true,
    },
    orderBy: {
      created_at: "desc",
    },
    take: 500,
  });

  for (const row of rows) {
    if (!row?.data) continue;

    try {
      const parsed =
        typeof row.data === "string" ? JSON.parse(row.data) : row.data;

      const parsedOrderId = normalizeOrderId(parsed?.order_id);

      if (parsedOrderId === oid) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function getOrderForPoints(order_id, client = null) {
  const tx = getClient(client);
  const oid = normalizeOrderId(order_id);

  if (!oid) return null;

  const order = await tx.orders.findUnique({
    where: {
      order_id: oid,
    },
    select: {
      order_id: true,
      user_id: true,
      total_amount: true,
      status: true,
    },
  });

  return order || null;
}

/* ======================= award points ======================= */

async function awardPointsCore(order_id, client = null) {
  const tx = getClient(client);
  const oid = normalizeOrderId(order_id);

  const order = await getOrderForPoints(oid, tx);

  if (!order) {
    return {
      awarded: false,
      reason: "order_not_found",
    };
  }

  const status = normalizeStatus(order.status);

  if (status !== "DELIVERED") {
    return {
      awarded: false,
      reason: "not_delivered",
    };
  }

  if (await hasPointsAwardNotification(oid, tx)) {
    return {
      awarded: false,
      reason: "already_awarded",
    };
  }

  const rule = await getActivePointRule(tx);

  if (!rule) {
    return {
      awarded: false,
      reason: "no_active_rule",
    };
  }

  const totalAmount = toNumber(order.total_amount, 0);
  const minAmount = toNumber(rule.min_amount_per_point, 0);
  const perPoint = toNumber(rule.point_to_award, 0);

  if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
    return {
      awarded: false,
      reason: "invalid_rule_or_amount",
    };
  }

  const units = Math.floor(totalAmount / minAmount);
  const points = units * perPoint;

  if (points <= 0) {
    return {
      awarded: false,
      reason: "computed_zero",
    };
  }

  const userId = Number(order.user_id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return {
      awarded: false,
      reason: "invalid_user_id",
    };
  }

  await tx.users.update({
    where: {
      user_id: userId,
    },
    data: {
      points: {
        increment: points,
      },
    },
  });

  const msg = `You earned ${points} points for order ${oid} (Nu. ${fmtNu(
    totalAmount,
  )} spent).`;

  await insertUserNotification(tx, {
    user_id: userId,
    type: "points_awarded",
    title: "Points earned",
    message: msg,
    data: {
      order_id: oid,
      points_awarded: points,
      total_amount: totalAmount,
      min_amount_per_point: Number(minAmount),
      point_to_award: Number(perPoint),
      rule_id: rule.point_id,
    },
    status: "unread",
  });

  return {
    awarded: true,
    points_awarded: points,
    total_amount: totalAmount,
    rule_id: rule.point_id,
  };
}

/**
 * Standalone points award.
 * Uses Prisma transaction.
 */
async function awardPointsForCompletedOrder(order_id) {
  return prisma.$transaction(async (tx) => {
    return awardPointsCore(order_id, tx);
  });
}

/**
 * Compatibility wrapper.
 *
 * Old code calls:
 * awardPointsForCompletedOrderWithConn(conn, order_id)
 *
 * New behavior:
 * - If first arg is Prisma transaction client, use it.
 * - If first arg is old MySQL conn, ignore it and use Prisma transaction.
 */
async function awardPointsForCompletedOrderWithConn(connOrTx, order_id) {
  if (connOrTx && typeof connOrTx.orders?.findUnique === "function") {
    return awardPointsCore(order_id, connOrTx);
  }

  return prisma.$transaction(async (tx) => {
    return awardPointsCore(order_id, tx);
  });
}

module.exports = {
  awardPointsForCompletedOrder,
  awardPointsForCompletedOrderWithConn,

  // exported for testing/debug if needed
  getActivePointRule,
  hasPointsAwardNotification,
};