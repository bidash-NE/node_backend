// models/orders/crud/create.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Keeps compatibility with old controller call: create(db, orderData)
// ✅ Inserts order + order_items inside one Prisma transaction

const { prisma, generateOrderId } = require("../helpers");

/* ======================= helpers ======================= */

function normalizeOrderId(v) {
  return String(v || generateOrderId()).trim().toUpperCase();
}

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeServiceType(v) {
  const s = String(v || "").trim().toUpperCase();

  if (s === "FOOD") return "FOOD";
  if (s === "MART") return "MART";

  throw new Error("Invalid service_type (must be FOOD or MART)");
}

function normalizePaymentMethod(v) {
  const s = String(v || "").trim().toUpperCase();

  // Prisma enum from your schema:
  // enum orders_payment_method {
  //   COD
  //   Wallet
  //   Card
  // }

  if (s === "COD") return "COD";
  if (s === "WALLET") return "Wallet";
  if (s === "CARD") return "Card";

  throw new Error("Invalid payment_method (must be COD, WALLET, or CARD)");
}

function normalizeFulfillmentType(v) {
  const s = String(v || "Delivery").trim();

  if (s.toUpperCase() === "PICKUP") return "Pickup";
  return "Delivery";
}

function normalizeDeliveryStatus(v) {
  const s = String(v || "PENDING").trim().toUpperCase();

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

function normalizeSpecialMode(v) {
  const s = String(v || "").trim().toUpperCase();

  if (!s) return null;
  if (s === "DROP_OFF" || s === "DROPOFF" || s === "DROP") return "DROP_OFF";
  if (s === "MEET_UP" || s === "MEETUP" || s === "MEET") return "MEET_UP";

  return null;
}

function normalizeDeliveryAddress(v) {
  if (v === undefined || v === null) return null;

  if (typeof v === "object") {
    return JSON.stringify(v);
  }

  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizePhotoUrls(v) {
  const arr = Array.isArray(v)
    ? v.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean)
    : [];

  return arr.length ? JSON.stringify(arr) : null;
}

function validateOrderItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Order must contain at least one item");
  }

  return items.map((item, index) => {
    const business_id = toInt(item.business_id);
    const menu_id = toInt(item.menu_id);
    const quantity = toInt(item.quantity, 1);

    if (!business_id || business_id <= 0) {
      throw new Error(`Invalid business_id for item index ${index}`);
    }

    if (!menu_id || menu_id <= 0) {
      throw new Error(`Invalid menu_id for item index ${index}`);
    }

    if (!quantity || quantity <= 0) {
      throw new Error(`Invalid quantity for item index ${index}`);
    }

    return {
      business_id,
      business_name: toStrOrNull(item.business_name) || "Unknown Business",
      menu_id,
      item_name: toStrOrNull(item.item_name) || "Item",
      item_image: toStrOrNull(item.item_image),
      quantity,
      price: toNumber(item.price, 0),
      subtotal:
        item.subtotal != null
          ? toNumber(item.subtotal, 0)
          : Number((quantity * toNumber(item.price, 0)).toFixed(2)),
      platform_fee: toNumber(item.platform_fee, 0),
      delivery_fee: toNumber(item.delivery_fee, 0),
    };
  });
}

/* ======================= create order ======================= */

/**
 * Compatible call styles:
 *
 * New:
 *   create(orderData)
 *
 * Old controller style:
 *   create(db, orderData)
 */
async function create(_maybeDbOrOrderData, maybeOrderData) {
  const orderData =
    maybeOrderData && typeof maybeOrderData === "object"
      ? maybeOrderData
      : _maybeDbOrOrderData;

  if (!orderData || typeof orderData !== "object") {
    throw new Error("orderData is required");
  }

  const order_id = normalizeOrderId(orderData.order_id);
  const items = validateOrderItems(orderData.items);

  const user_id = toInt(orderData.user_id);

  if (!user_id || user_id <= 0) {
    throw new Error("Invalid user_id");
  }

  const service_type = normalizeServiceType(orderData.service_type);
  const payment_method = normalizePaymentMethod(orderData.payment_method);

  const business_id = items?.[0]?.business_id || null;

  const orderPayload = {
    order_id,
    user_id,
    service_type,
    business_id,

    total_amount: toNumber(orderData.total_amount, 0),
    discount_amount: toNumber(orderData.discount_amount, 0),
    delivery_fee: toNumber(orderData.delivery_fee, 0),
    platform_fee: toNumber(orderData.platform_fee, 0),
    merchant_delivery_fee:
      orderData.merchant_delivery_fee != null
        ? toNumber(orderData.merchant_delivery_fee, 0)
        : null,

    payment_method,
    delivery_address: normalizeDeliveryAddress(orderData.delivery_address),

    note_for_restaurant: toStrOrNull(orderData.note_for_restaurant),
    if_unavailable:
      orderData.if_unavailable !== undefined && orderData.if_unavailable !== null
        ? String(orderData.if_unavailable)
        : null,

    status: String(orderData.status || "PENDING").trim().toUpperCase(),
    fulfillment_type: normalizeFulfillmentType(orderData.fulfillment_type),
    priority: !!orderData.priority,

    delivery_floor_unit: toStrOrNull(orderData.delivery_floor_unit),
    delivery_instruction_note: toStrOrNull(
      orderData.delivery_instruction_note,
    ),

    delivery_photo_url: toStrOrNull(orderData.delivery_photo_url),
    delivery_photo_urls: normalizePhotoUrls(orderData.delivery_photo_urls),

    delivery_special_mode: normalizeSpecialMode(
      orderData.delivery_special_mode || orderData.special_mode,
    ),

    delivery_status: normalizeDeliveryStatus(orderData.delivery_status),

    created_at: new Date(),
    updated_at: new Date(),
  };

  await prisma.$transaction(async (tx) => {
    await tx.orders.create({
      data: orderPayload,
    });

    await tx.order_items.createMany({
      data: items.map((item) => ({
        order_id,
        business_id: item.business_id,
        business_name: item.business_name,
        menu_id: item.menu_id,
        item_name: item.item_name,
        item_image: item.item_image,
        quantity: item.quantity,
        price: item.price,
        subtotal: item.subtotal,
        platform_fee: item.platform_fee,
        delivery_fee: item.delivery_fee,
      })),
    });
  });

  return order_id;
}

module.exports = create;