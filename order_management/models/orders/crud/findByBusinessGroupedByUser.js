// models/orders/crud/findByBusinessGroupedByUser.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Does NOT depend on Prisma relation name `orders.users`
// ✅ Fixes: Unknown field `users` for include statement on model `orders`
// ✅ Keeps compatibility with old controller call:
//    findByBusinessGroupedByUser(db, business_id)

const {
  prisma,
  getOwnerTypeByBusinessId,
  parseDeliveryAddress,
} = require("../helpers");

/* ---------------- helpers ---------------- */

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

function parsePhotoUrls(deliveryPhotoUrls, deliveryPhotoUrl) {
  let photos = [];

  if (deliveryPhotoUrls) {
    if (Array.isArray(deliveryPhotoUrls)) {
      photos = deliveryPhotoUrls;
    } else {
      try {
        const parsed = JSON.parse(deliveryPhotoUrls);
        if (Array.isArray(parsed)) photos = parsed;
      } catch {}
    }
  }

  if (!photos.length && deliveryPhotoUrl) {
    photos = [deliveryPhotoUrl];
  }

  return photos.map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeStatus(status) {
  let st = String(status || "").toUpperCase();

  if (st === "COMPLETED") {
    st = "DELIVERED";
  }

  return st;
}

function normalizeServiceType(v, fallback = null) {
  const s = String(v || "").trim().toUpperCase();

  if (s === "FOOD") return "FOOD";
  if (s === "MART") return "MART";

  return fallback;
}

/**
 * Compatible call styles:
 *
 * New:
 *   findByBusinessGroupedByUser(business_id)
 *
 * Old controller style:
 *   findByBusinessGroupedByUser(db, business_id)
 */
module.exports = async function findByBusinessGroupedByUser(
  _maybeDbOrBusinessId,
  maybeBusinessId,
) {
  const rawBusinessId =
    maybeBusinessId !== undefined ? maybeBusinessId : _maybeDbOrBusinessId;

  const bid = toInt(rawBusinessId);

  if (!bid || bid <= 0) {
    return [];
  }

  const derivedServiceType = (await getOwnerTypeByBusinessId(bid)) || null;

  /*
    Step 1:
    Old SQL started from order_items where business_id = ?
  */
  const itemsRaw = await prisma.order_items.findMany({
    where: {
      business_id: bid,
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

  if (!itemsRaw.length) {
    return [];
  }

  const items = itemsRaw.map(serializeRow);

  const orderIds = Array.from(
    new Set(
      items
        .map((it) => String(it.order_id || "").trim())
        .filter(Boolean),
    ),
  );

  if (!orderIds.length) {
    return [];
  }

  /*
    Step 2:
    Fetch orders separately.
    This avoids using include: { orders: { include: { users: ... } } }
    because your Prisma schema does not expose orders.users relation.
  */
  const ordersRaw = await prisma.orders.findMany({
    where: {
      order_id: {
        in: orderIds,
      },
    },
    orderBy: [
      {
        created_at: "desc",
      },
      {
        order_id: "desc",
      },
    ],
  });

  if (!ordersRaw.length) {
    return [];
  }

  const orders = ordersRaw.map(serializeRow);

  const orderMap = new Map();

  for (const order of orders) {
    orderMap.set(order.order_id, order);
  }

  /*
    Step 3:
    Fetch users separately by order.user_id.
    This replaces LEFT JOIN users u ON u.user_id = o.user_id.
  */
  const userIds = Array.from(
    new Set(
      orders
        .map((o) => Number(o.user_id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );

  const userMap = new Map();

  if (userIds.length) {
    const usersRaw = await prisma.users.findMany({
      where: {
        user_id: {
          in: userIds,
        },
      },
      select: {
        user_id: true,
        user_name: true,
        email: true,
        phone: true,
      },
    });

    for (const userRaw of usersRaw) {
      const user = serializeRow(userRaw);
      userMap.set(Number(user.user_id), user);
    }
  }

  /*
    Step 4:
    Rebuild joined rows in the same order as:
    ORDER BY o.created_at DESC, o.order_id DESC, oi.menu_id ASC
  */
  const itemsByOrder = new Map();

  for (const item of items) {
    if (!orderMap.has(item.order_id)) continue;

    if (!itemsByOrder.has(item.order_id)) {
      itemsByOrder.set(item.order_id, []);
    }

    itemsByOrder.get(item.order_id).push(item);
  }

  const byUser = new Map();

  for (const order of orders) {
    const orderItems = itemsByOrder.get(order.order_id) || [];

    for (const item of orderItems) {
      const uid = Number(order.user_id);
      const user = userMap.get(uid) || {};

      if (!byUser.has(uid)) {
        byUser.set(uid, {
          user: {
            user_id: uid,
            name: user.user_name || null,
            email: user.email || null,
            phone: user.phone || null,
          },
          orders: [],
          _ordersMap: new Map(),
        });
      }

      const group = byUser.get(uid);

      if (!group._ordersMap.has(order.order_id)) {
        const st = normalizeStatus(order.status);

        const deliverTo = parseDeliveryAddress(order.delivery_address) || {};

        if (deliverTo.lat == null && order.delivery_lat != null) {
          deliverTo.lat = Number(order.delivery_lat);
        }

        if (deliverTo.lng == null && order.delivery_lng != null) {
          deliverTo.lng = Number(order.delivery_lng);
        }

        const deliveryPhotos = parsePhotoUrls(
          order.delivery_photo_urls,
          order.delivery_photo_url,
        );

        deliverTo.delivery_floor_unit = order.delivery_floor_unit || null;
        deliverTo.delivery_instruction_note =
          order.delivery_instruction_note || null;
        deliverTo.delivery_special_mode =
          order.delivery_special_mode || null;

        // Full delivery photo list for new UI
        deliverTo.delivery_photo_urls = deliveryPhotos;

        // Old UI compatibility:
        // Your old code intentionally commented this out, so keep it out.
        // deliverTo.delivery_photo_url = deliveryPhotos[0] || null;

        const orderObj = {
          order_id: order.order_id,
          service_type: normalizeServiceType(
            order.service_type,
            derivedServiceType,
          ),
          status: st,
          status_reason: order.status_reason || null,

          // Sum of item subtotals for THIS merchant within this order
          items_total: 0,

          payment_method: order.payment_method,
          fulfillment_type: order.fulfillment_type,
          priority: order.priority,
          estimated_arrivial_time: order.estimated_arrivial_time || null,

          note_for_restaurant: order.note_for_restaurant || null,
          if_unavailable: order.if_unavailable || null,

          deliver_to: deliverTo,

          totals: {
            total_amount: toNumber(order.total_amount, 0),
            discount_amount: toNumber(order.discount_amount, 0),
            delivery_fee: toNumber(order.delivery_fee, 0),
            platform_fee: toNumber(order.platform_fee, 0),
            merchant_delivery_fee:
              order.merchant_delivery_fee != null
                ? Number(order.merchant_delivery_fee)
                : null,
          },

          created_at: order.created_at,
          updated_at: order.updated_at,

          business: {
            business_id: item.business_id,
            business_name: item.business_name || null,
          },

          items: [],
        };

        group._ordersMap.set(order.order_id, orderObj);
        group.orders.push(orderObj);
      }

      const orderRef = group._ordersMap.get(order.order_id);

      const lineSubtotal = toNumber(item.subtotal, 0);

      orderRef.items_total = Number(
        (Number(orderRef.items_total || 0) + lineSubtotal).toFixed(2),
      );

      orderRef.items.push({
        item_id: item.item_id,
        business_id: item.business_id,
        business_name: item.business_name,
        menu_id: item.menu_id,
        item_name: item.item_name,
        item_image: item.item_image || null,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.subtotal,
        platform_fee: toNumber(item.platform_fee, 0),
        delivery_fee: toNumber(item.delivery_fee, 0),
      });
    }
  }

  const out = Array.from(byUser.values()).map((g) => {
    delete g._ordersMap;

    g.orders = (g.orders || []).map((o) => ({
      ...o,
      items_total: Number(Number(o.items_total || 0).toFixed(2)),
    }));

    return g;
  });

  return out;
};