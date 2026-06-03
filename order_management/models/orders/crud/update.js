// models/orders/crud/update.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: update(db, order_id, orderData)

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

  return st || null;
}

function normalizeServiceType(v) {
  if (v == null) return null;

  const st = String(v || "").trim().toUpperCase();

  if (!["FOOD", "MART"].includes(st)) {
    throw new Error("Invalid service_type (must be FOOD or MART)");
  }

  return st;
}

function normalizePaymentMethod(v) {
  if (v == null) return null;

  const s = String(v || "").trim().toUpperCase();

  // Prisma enum in your schema:
  // COD, Wallet, Card
  if (s === "COD") return "COD";
  if (s === "WALLET") return "Wallet";
  if (s === "CARD") return "Card";

  return String(v).trim();
}

function normalizeFulfillmentType(v) {
  if (v == null) return null;

  const s = String(v || "").trim();

  if (s.toUpperCase() === "PICKUP") return "Pickup";
  if (s.toUpperCase() === "DELIVERY") return "Delivery";

  return s;
}

function normalizeDeliveryAddress(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;

  if (typeof v === "object") {
    return JSON.stringify(v);
  }

  return String(v);
}

function normalizePhotoUrls(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;

  if (Array.isArray(v)) {
    const arr = v.map((x) => String(x || "").trim()).filter(Boolean);
    return arr.length ? JSON.stringify(arr) : null;
  }

  return String(v);
}

function normalizeSpecialMode(v) {
  if (v == null) return null;

  const s = String(v || "").trim().toUpperCase();

  if (!s) return null;
  if (s === "DROP_OFF" || s === "DROPOFF" || s === "DROP") return "DROP_OFF";
  if (s === "MEET_UP" || s === "MEETUP" || s === "MEET") return "MEET_UP";

  return s;
}

function normalizeDeliveryStatus(v) {
  if (v == null) return null;

  const s = String(v || "").trim().toUpperCase();

  const allowed = new Set([
    "PENDING",
    "ASSIGNED",
    "PICKED_UP",
    "ON_ROAD",
    "DELIVERED",
    "CANCELLED",
  ]);

  return allowed.has(s) ? s : "PENDING";
}

function toNumberOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;

  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toBool(v) {
  if (v === undefined) return undefined;
  return !!v;
}

function toStrOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;

  const s = String(v).trim();
  return s.length ? s : null;
}

/*
  Only allow fields that exist in your Prisma `orders` model.
  This prevents Prisma from crashing if req.body contains unknown frontend fields.
*/
function buildOrderUpdateData(orderData = {}) {
  const data = {};

  if (Object.prototype.hasOwnProperty.call(orderData, "user_id")) {
    data.user_id = toIntOrNull(orderData.user_id);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "business_id")) {
    data.business_id = toIntOrNull(orderData.business_id);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "service_type")) {
    data.service_type = normalizeServiceType(orderData.service_type);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "status")) {
    data.status = normalizeStatus(orderData.status);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "status_reason")) {
    data.status_reason = toStrOrNull(orderData.status_reason);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "total_amount")) {
    data.total_amount = toNumberOrNull(orderData.total_amount);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "discount_amount")) {
    data.discount_amount = toNumberOrNull(orderData.discount_amount);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_fee")) {
    data.delivery_fee = toNumberOrNull(orderData.delivery_fee);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "platform_fee")) {
    data.platform_fee = toNumberOrNull(orderData.platform_fee);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "merchant_delivery_fee")) {
    data.merchant_delivery_fee = toNumberOrNull(
      orderData.merchant_delivery_fee,
    );
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "payment_method")) {
    data.payment_method = normalizePaymentMethod(orderData.payment_method);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_address")) {
    data.delivery_address = normalizeDeliveryAddress(orderData.delivery_address);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_lat")) {
    data.delivery_lat = toNumberOrNull(orderData.delivery_lat);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_lng")) {
    data.delivery_lng = toNumberOrNull(orderData.delivery_lng);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_floor_unit")) {
    data.delivery_floor_unit = toStrOrNull(orderData.delivery_floor_unit);
  }

  if (
    Object.prototype.hasOwnProperty.call(
      orderData,
      "delivery_instruction_note",
    )
  ) {
    data.delivery_instruction_note = toStrOrNull(
      orderData.delivery_instruction_note,
    );
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_photo_url")) {
    data.delivery_photo_url = toStrOrNull(orderData.delivery_photo_url);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_photo_urls")) {
    data.delivery_photo_urls = normalizePhotoUrls(orderData.delivery_photo_urls);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_special_mode")) {
    data.delivery_special_mode = normalizeSpecialMode(
      orderData.delivery_special_mode,
    );
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_status")) {
    data.delivery_status = normalizeDeliveryStatus(orderData.delivery_status);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivered_at")) {
    data.delivered_at = orderData.delivered_at
      ? new Date(orderData.delivered_at)
      : null;
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_batch_id")) {
    data.delivery_batch_id = toStrOrNull(orderData.delivery_batch_id);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_driver_id")) {
    data.delivery_driver_id = toStrOrNull(orderData.delivery_driver_id);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_ride_id")) {
    data.delivery_ride_id = toStrOrNull(orderData.delivery_ride_id);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "note_for_restaurant")) {
    data.note_for_restaurant = toStrOrNull(orderData.note_for_restaurant);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "if_unavailable")) {
    data.if_unavailable =
      orderData.if_unavailable !== undefined &&
      orderData.if_unavailable !== null
        ? String(orderData.if_unavailable)
        : null;
  }

  if (
    Object.prototype.hasOwnProperty.call(orderData, "estimated_arrivial_time")
  ) {
    data.estimated_arrivial_time = toStrOrNull(
      orderData.estimated_arrivial_time,
    );
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "fulfillment_type")) {
    data.fulfillment_type = normalizeFulfillmentType(orderData.fulfillment_type);
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "priority")) {
    data.priority = toBool(orderData.priority);
  }

  // Always update updated_at like the old SQL did with NOW()
  data.updated_at = new Date();

  // Remove undefined fields. Keep null fields because null means user wants to clear value.
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }

  return data;
}

/**
 * Compatible call styles:
 *
 * New:
 *   update(order_id, orderData)
 *
 * Old controller style:
 *   update(db, order_id, orderData)
 */
module.exports = async function update(
  _maybeDbOrOrderId,
  maybeOrderIdOrData,
  maybeOrderData,
) {
  const usingOldDbArg =
    _maybeDbOrOrderId && typeof _maybeDbOrOrderId.query === "function";

  const order_id = normalizeOrderId(
    usingOldDbArg ? maybeOrderIdOrData : _maybeDbOrOrderId,
  );

  const orderData = usingOldDbArg ? maybeOrderData : maybeOrderIdOrData;

  if (!order_id) {
    return 0;
  }

  if (!orderData || !Object.keys(orderData).length) {
    return 0;
  }

  const data = buildOrderUpdateData(orderData);

  // If only updated_at exists but no actual update field was supplied, keep old behavior: no update.
  if (Object.keys(data).length <= 1 && data.updated_at) {
    return 0;
  }

  const result = await prisma.orders.updateMany({
    where: {
      order_id,
    },
    data,
  });

  return result.count || 0;
};