// models/orders/crud/findByUserIdForApp.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call:
//    findByUserIdForApp(db, user_id, service_type)
// ✅ Preserves final response shape used by the app

const {
  prisma,
  resolveOrderServiceType,
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

function normalizeServiceType(v) {
  const s = String(v || "").trim().toUpperCase();

  if (s === "FOOD") return "FOOD";
  if (s === "MART") return "MART";

  return null;
}

function parsePhotoList(v) {
  if (v == null) return [];

  if (Array.isArray(v)) {
    return v.map(String).filter(Boolean);
  }

  const s = String(v).trim();

  if (!s) return [];

  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [s].filter(Boolean);
  }
}

/**
 * Compatible call styles:
 *
 * New:
 *   findByUserIdForApp(user_id, service_type)
 *
 * Old controller style:
 *   findByUserIdForApp(db, user_id, service_type)
 */
module.exports = async function findByUserIdForApp(
  dbOrUserId,
  maybeUserIdOrServiceType = null,
  maybeServiceType = null,
) {
  const usingOldDbArg =
    dbOrUserId && typeof dbOrUserId.query === "function";

  const user_id = usingOldDbArg
    ? toInt(maybeUserIdOrServiceType)
    : toInt(dbOrUserId);

  const service_type = usingOldDbArg
    ? maybeServiceType
    : maybeUserIdOrServiceType;

  if (!user_id || user_id <= 0) {
    return [];
  }

  const serviceFilter = normalizeServiceType(service_type);

  const where = {
    user_id,
    ...(serviceFilter ? { service_type: serviceFilter } : {}),
  };

  const ordersRaw = await prisma.orders.findMany({
    where,
    orderBy: {
      created_at: "desc",
    },
  });

  if (!ordersRaw.length) {
    return [];
  }

  const orderIds = ordersRaw.map((o) => o.order_id);

  const itemsRaw = await prisma.order_items.findMany({
    where: {
      order_id: {
        in: orderIds,
      },
    },
    select: {
      order_id: true,
      business_id: true,
      business_name: true,
      menu_id: true,
      item_name: true,
      item_image: true,
      quantity: true,
      price: true,
      subtotal: true,
      platform_fee: true,
      delivery_fee: true,
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

  const items = itemsRaw.map(serializeRow);

  const itemsByOrder = new Map();
  const businessIdsSet = new Set();

  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) {
      itemsByOrder.set(it.order_id, []);
    }

    itemsByOrder.get(it.order_id).push(it);

    const bid = Number(it.business_id);

    if (Number.isFinite(bid) && bid > 0) {
      businessIdsSet.add(bid);
    }
  }

  const businessMap = new Map();
  const bizIds = Array.from(businessIdsSet);

  if (bizIds.length) {
    try {
      /*
        Old SQL dynamically checked possible address/logo column names.
        Your schema already has:
        - merchant_business_details.business_logo
        - merchant_business_details.address
        - merchant_business_details.latitude
        - merchant_business_details.longitude

        If your schema field names are different, adjust only this select block.
      */
      const bizRowsRaw = await prisma.merchant_business_details.findMany({
        where: {
          business_id: {
            in: bizIds.map((id) => BigInt(id)),
          },
        },
        select: {
          business_id: true,
          address: true,
          latitude: true,
          longitude: true,
          business_logo: true,
        },
      });

      const bizRows = bizRowsRaw.map(serializeRow);

      for (const r of bizRows) {
        const bid = Number(r.business_id);

        if (!Number.isFinite(bid) || bid <= 0) continue;

        businessMap.set(bid, {
          address: r.address != null ? String(r.address).trim() : null,
          lat:
            r.latitude != null &&
            r.latitude !== "" &&
            !Number.isNaN(Number(r.latitude))
              ? Number(r.latitude)
              : null,
          lng:
            r.longitude != null &&
            r.longitude !== "" &&
            !Number.isNaN(Number(r.longitude))
              ? Number(r.longitude)
              : null,
          business_logo:
            r.business_logo != null
              ? String(r.business_logo).trim()
              : null,
        });
      }
    } catch (e) {
      console.error("[findByUserIdForApp] business lookup failed:", e?.message);
    }
  }

  const result = [];

  for (const orderRaw of ordersRaw) {
    const o = serializeRow(orderRaw);

    const its = itemsByOrder.get(o.order_id) || [];
    const primaryBiz = its[0] || null;

    let st = o.service_type || null;

    if (!st) {
      try {
        st = await resolveOrderServiceType(o.order_id);
      } catch {}
    }

    const deliverTo = parseDeliveryAddress(o.delivery_address) || {};

    if (deliverTo.lat == null && o.delivery_lat != null) {
      deliverTo.lat = Number(o.delivery_lat);
    }

    if (deliverTo.lng == null && o.delivery_lng != null) {
      deliverTo.lng = Number(o.delivery_lng);
    }

    deliverTo.delivery_floor_unit = o.delivery_floor_unit || null;
    deliverTo.delivery_instruction_note =
      o.delivery_instruction_note || null;
    deliverTo.delivery_special_mode = o.delivery_special_mode || null;

    const listFromCol = parsePhotoList(o.delivery_photo_urls);

    const legacy = o.delivery_photo_url
      ? String(o.delivery_photo_url).trim()
      : "";

    const merged = Array.from(
      new Set([...listFromCol, ...(legacy ? [legacy] : [])]),
    ).filter(Boolean);

    deliverTo.delivery_photo_urls = merged;
    deliverTo.delivery_photo_url = merged[0] || null;

    const bid = primaryBiz ? Number(primaryBiz.business_id) : null;
    const bizInfo = bid && businessMap.has(bid) ? businessMap.get(bid) : null;

    result.push({
      order_id: o.order_id,
      service_type: st || null,
      status: o.status,
      status_reason: o.status_reason || null,
      payment_method: o.payment_method,
      fulfillment_type: o.fulfillment_type,
      created_at: o.created_at,
      updated_at: o.updated_at,
      if_unavailable: o.if_unavailable || null,
      estimated_arrivial_time: o.estimated_arrivial_time || null,

      delivery_batch_id:
        o.delivery_batch_id != null ? o.delivery_batch_id : null,
      delivery_ride_id:
        o.delivery_ride_id != null ? o.delivery_ride_id : null,
      delivery_driver_id:
        o.delivery_driver_id != null ? o.delivery_driver_id : null,

      business_details: primaryBiz
        ? {
            business_id: primaryBiz.business_id,
            name: primaryBiz.business_name,
            address: bizInfo?.address ?? null,
            lat: bizInfo?.lat ?? null,
            lng: bizInfo?.lng ?? null,
            business_logo: bizInfo?.business_logo ?? null,
          }
        : null,

      deliver_to: deliverTo,

      totals: {
        items_subtotal: its.reduce(
          (s, it) => s + Number(it.subtotal || 0),
          0,
        ),
        delivery_fee: toNumber(o.delivery_fee, 0),
        merchant_delivery_fee:
          o.merchant_delivery_fee !== null &&
          o.merchant_delivery_fee !== undefined
            ? Number(o.merchant_delivery_fee)
            : null,
        platform_fee: toNumber(o.platform_fee, 0),
        discount_amount: toNumber(o.discount_amount, 0),
        total_amount: toNumber(o.total_amount, 0),
      },

      items: its.map((it) => ({
        menu_id: it.menu_id,
        name: it.item_name,
        image: it.item_image,
        quantity: it.quantity,
        unit_price: it.price,
        line_subtotal: it.subtotal,
      })),
    });
  }

  return result;
};