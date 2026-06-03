// models/orders/orderNotifications.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps same exported function names for controller compatibility

const { prisma } = require("../../lib/prisma");

const fmtNu = (n) => Number(n || 0).toFixed(2);

/* ======================= HELPERS ======================= */

function getClient(client = null) {
  return client || prisma;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toJsonOrNull(data) {
  if (data == null) return null;

  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

function normalizeNotificationStatus(status) {
  return String(status || "").toLowerCase() === "read" ? "read" : "unread";
}

/**
 * Inserts user notification.
 *
 * NOTE:
 * The old version accepted `conn` as first argument.
 * This Prisma version still accepts that parameter, but expects either:
 * - null/undefined
 * - prisma
 * - Prisma transaction client
 *
 * If old code still passes MySQL conn, it will be ignored safely and normal prisma is used.
 */
async function insertUserNotification(
  client,
  { user_id, title, message, type = "wallet", data = null, status = "unread" },
) {
  const uid = toPositiveInt(user_id);

  if (!uid) {
    throw new Error("user_id must be a positive integer");
  }

  const tx =
    client && typeof client.notifications?.create === "function"
      ? client
      : prisma;

  await tx.notifications.create({
    data: {
      user_id: uid,
      type: String(type || "wallet"),
      title: String(title || "Notification"),
      message: String(message || ""),
      data: toJsonOrNull(data),
      status: normalizeNotificationStatus(status),
      created_at: new Date(),
    },
  });
}

function humanOrderStatus(status) {
  const s = String(status || "").toUpperCase();

  switch (s) {
    case "PENDING":
      return "pending";

    case "CONFIRMED":
      return "accepted by the store";

    case "PREPARING":
      return "being prepared";

    case "READY":
      return "ready for pickup";

    case "OUT_FOR_DELIVERY":
      return "out for delivery";

    case "DELIVERED":
    case "COMPLETED":
      return "delivered";

    case "CANCELLED":
      return "cancelled";

    case "DECLINED":
      return "declined by the store";

    default:
      return s.toLowerCase();
  }
}

/* ======================= INTERNAL NOTIFICATIONS ======================= */

async function addUserOrderStatusNotificationInternal(
  user_id,
  order_id,
  status,
  reason = "",
  client = null,
) {
  const uid = toPositiveInt(user_id);

  if (!uid) {
    throw new Error("user_id must be a positive integer");
  }

  const oid = String(order_id || "").trim().toUpperCase();

  if (!oid) {
    throw new Error("order_id is required");
  }

  let normalized = String(status || "").toUpperCase();

  if (normalized === "COMPLETED") {
    normalized = "DELIVERED";
  }

  const trimmedReason = String(reason || "").trim();

  let message;

  if (normalized === "CONFIRMED") {
    message = `Your order ${oid} is accepted successfully.`;
  } else {
    const nice = humanOrderStatus(normalized);
    message = `Your order ${oid} is now ${nice}.`;
  }

  if (trimmedReason) {
    message += ` Reason: ${trimmedReason}`;
  }

  await insertUserNotification(client, {
    user_id: uid,
    type: "order_status",
    title: "Order update",
    message,
    data: {
      order_id: oid,
      status: normalized,
      reason: trimmedReason || null,
    },
    status: "unread",
  });
}

async function addUserUnavailableItemNotificationInternal(
  user_id,
  order_id,
  changes,
  final_total_amount = null,
  client = null,
) {
  const uid = toPositiveInt(user_id);

  if (!uid) {
    throw new Error("user_id must be a positive integer");
  }

  const oid = String(order_id || "").trim().toUpperCase();

  if (!oid) {
    throw new Error("order_id is required");
  }

  const removed = Array.isArray(changes?.removed) ? changes.removed : [];
  const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];

  const lines = [];

  if (removed.length) {
    const names = removed
      .map((x) => x.item_name || x.menu_id)
      .filter(Boolean)
      .join(", ");

    lines.push(
      names
        ? `Removed items: ${names}.`
        : "Some unavailable items were removed from your order.",
    );
  }

  if (replaced.length) {
    const names = replaced
      .map((x) => x.new?.item_name || x.old?.item_name || x.old?.menu_id)
      .filter(Boolean)
      .join(", ");

    lines.push(
      names
        ? `Replaced items: ${names}.`
        : "Some unavailable items were replaced with alternatives.",
    );
  }

  if (!lines.length) return;

  if (final_total_amount != null) {
    lines.push(
      `Your final payable amount for this order is Nu. ${fmtNu(
        final_total_amount,
      )}.`,
    );
  }

  await insertUserNotification(client, {
    user_id: uid,
    type: "order_unavailable_items",
    title: `Items updated in order ${oid}`,
    message: lines.join(" "),
    data: {
      order_id: oid,
      changes: {
        removed,
        replaced,
      },
      final_total_amount:
        final_total_amount != null ? Number(final_total_amount) : null,
    },
    status: "unread",
  });
}

async function addUserWalletDebitNotificationInternal(
  user_id,
  order_id,
  order_amount,
  platform_fee,
  method,
  client = null,
) {
  const uid = toPositiveInt(user_id);

  if (!uid) {
    throw new Error("user_id must be a positive integer");
  }

  const oid = String(order_id || "").trim().toUpperCase();

  if (!oid) {
    throw new Error("order_id is required");
  }

  const payMethod = String(method || "").toUpperCase();
  const orderAmt = Number(order_amount || 0);
  const feeAmt = Number(platform_fee || 0);

  if (!(orderAmt > 0 || feeAmt > 0)) return;

  let message;

  if (payMethod === "WALLET") {
    message =
      `Your order ${oid} is accepted successfully. ` +
      `Nu. ${fmtNu(orderAmt)} has been deducted from your wallet for the order and ` +
      `Nu. ${fmtNu(feeAmt)} as platform fee (your share).`;
  } else {
    message = `Order ${oid}: Nu. ${fmtNu(
      feeAmt,
    )} was deducted from your wallet as platform fee (your share).`;
  }

  await insertUserNotification(client, {
    user_id: uid,
    type: "wallet_debit",
    title: "Wallet deduction",
    message,
    data: {
      order_id: oid,
      order_amount: orderAmt,
      platform_fee: feeAmt,
      method: payMethod,
    },
    status: "unread",
  });
}

/* ======================= EXPORTED WRAPPERS ======================= */

async function addUserOrderStatusNotification({
  user_id,
  order_id,
  status,
  reason = "",
  conn = null,
  tx = null,
}) {
  return addUserOrderStatusNotificationInternal(
    user_id,
    order_id,
    status,
    reason,
    tx || conn,
  );
}

async function addUserUnavailableItemNotification({
  user_id,
  order_id,
  changes,
  final_total_amount = null,
  conn = null,
  tx = null,
}) {
  return addUserUnavailableItemNotificationInternal(
    user_id,
    order_id,
    changes,
    final_total_amount,
    tx || conn,
  );
}

async function addUserWalletDebitNotification({
  user_id,
  order_id,
  order_amount,
  platform_fee,
  method,
  conn = null,
  tx = null,
}) {
  return addUserWalletDebitNotificationInternal(
    user_id,
    order_id,
    order_amount,
    platform_fee,
    method,
    tx || conn,
  );
}

module.exports = {
  insertUserNotification,
  addUserOrderStatusNotification,
  addUserUnavailableItemNotification,
  addUserWalletDebitNotification,
};