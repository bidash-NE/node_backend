// models/orders/crud/findByOrderIdGrouped.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: findByOrderIdGrouped(db, order_id)

const {
  prisma,
  resolveOrderServiceType,
  parseDeliveryAddress,
} = require("../helpers");

/* ---------------- helpers ---------------- */

function normalizeOrderId(v) {
  return String(v || "").trim().toUpperCase();
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
 *   findByOrderIdGrouped(order_id)
 *
 * Old controller style:
 *   findByOrderIdGrouped(db, order_id)
 */
module.exports = async function findByOrderIdGrouped(
  _maybeDbOrOrderId,
  maybeOrderId,
) {
  const order_id = normalizeOrderId(maybeOrderId || _maybeDbOrOrderId);

  if (!order_id) {
    return [];
  }

  const orderRaw = await prisma.orders.findUnique({
    where: {
      order_id,
    },
    include: {
      users: {
        select: {
          user_id: true,
          user_name: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  if (!orderRaw) {
    return [];
  }

  const itemsRaw = await prisma.order_items.findMany({
    where: {
      order_id,
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

  const o = serializeRow(orderRaw);
  const user = serializeRow(orderRaw.users || {});
  const items = itemsRaw.map(serializeRow);

  let resolvedServiceType = o.service_type || null;

  if (!resolvedServiceType) {
    try {
      resolvedServiceType = await resolveOrderServiceType(order_id);
    } catch {}
  }

  return [
    {
      user: {
        user_id: o.user_id,
        name: user.user_name || null,
        email: user.email || null,
        phone: user.phone || null,
      },
      orders: [
        {
          order_id: o.order_id,
          service_type: resolvedServiceType || null,
          status: o.status,
          status_reason: o.status_reason || null,

          total_amount: o.total_amount,
          discount_amount: o.discount_amount,
          delivery_fee: o.delivery_fee,
          platform_fee: o.platform_fee,
          merchant_delivery_fee: o.merchant_delivery_fee,

          payment_method: o.payment_method,
          delivery_address: parseDeliveryAddress(o.delivery_address),

          note_for_restaurant: o.note_for_restaurant,
          if_unavailable: o.if_unavailable || null,
          estimated_arrivial_time: o.estimated_arrivial_time || null,

          fulfillment_type: o.fulfillment_type,
          priority: o.priority,

          created_at: o.created_at,
          updated_at: o.updated_at,

          items,
        },
      ],
    },
  ];
};