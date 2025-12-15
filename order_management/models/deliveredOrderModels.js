// models/deliveredOrderModels.js
const db = require("../config/db");

async function getDeliveredOrdersByUser(
  user_id,
  { limit = 100, offset = 0 } = {}
) {
  const uid = Number(user_id);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const [orders] = await db.query(
    `
    SELECT *
      FROM delivered_orders
     WHERE user_id = ?
     ORDER BY delivered_at DESC
     LIMIT ? OFFSET ?
    `,
    [uid, lim, off]
  );

  if (!orders.length) return [];

  const ids = orders.map((o) => o.order_id);
  const [items] = await db.query(
    `
    SELECT *
      FROM delivered_order_items
     WHERE order_id IN (?)
     ORDER BY order_id, business_id, menu_id
    `,
    [ids]
  );

  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }

  return orders.map((o) => ({
    ...o,
    items: itemsByOrder.get(o.order_id) || [],
  }));
}

async function deleteDeliveredOrderByUser(user_id, order_id) {
  const uid = Number(user_id);
  const oid = String(order_id || "").trim();
  if (!uid || !oid) return { deleted: 0 };

  // FK in delivered_order_items is ON DELETE CASCADE => items auto delete
  const [r] = await db.query(
    `DELETE FROM delivered_orders WHERE user_id = ? AND order_id = ? LIMIT 1`,
    [uid, oid]
  );

  return { deleted: r.affectedRows || 0 };
}

async function deleteManyDeliveredOrdersByUser(user_id, order_ids = []) {
  const uid = Number(user_id);
  const ids = Array.isArray(order_ids)
    ? order_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  if (!uid || !ids.length) return { deleted: 0 };

  const placeholders = ids.map(() => "?").join(", ");
  const params = [uid, ...ids];

  const [r] = await db.query(
    `DELETE FROM delivered_orders WHERE user_id = ? AND order_id IN (${placeholders})`,
    params
  );

  return { deleted: r.affectedRows || 0 };
}

module.exports = {
  getDeliveredOrdersByUser,
  deleteDeliveredOrderByUser,
  deleteManyDeliveredOrdersByUser,
};
