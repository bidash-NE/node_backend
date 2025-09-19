// models/orderModels.js
const db = require("../config/db");

function generateOrderId() {
  const randomNum = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${randomNum}`;
}

/** Cache whether orders.status_reason exists */
let _hasStatusReason = null;
async function ensureStatusReasonSupport() {
  if (_hasStatusReason !== null) return _hasStatusReason;
  const [rows] = await db.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'status_reason'
    `
  );
  _hasStatusReason = rows.length > 0;
  return _hasStatusReason;
}

const Order = {
  create: async (orderData) => {
    const order_id = generateOrderId();

    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      total_amount: orderData.total_amount,
      discount_amount: orderData.discount_amount,
      payment_method: orderData.payment_method, // e.g. "COD", "Wallet", "Card"
      delivery_address: orderData.delivery_address,
      note_for_restaurant: orderData.note_for_restaurant,
      status: (orderData.status || "PENDING").toUpperCase(),
      fulfillment_type: orderData.fulfillment_type || "Delivery",
      priority: !!orderData.priority,
    });

    for (const item of orderData.items || []) {
      await db.query(`INSERT INTO order_items SET ?`, {
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
      });
    }
    return order_id;
  },

  findAll: async () => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.* ${hasReason ? "" : ""} ${/* o has all columns; fine */ ""}
      FROM orders o
      ORDER BY o.created_at DESC
      `
    );
    if (!orders.length) return [];

    const ids = orders.map((o) => o.order_id);
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id IN (?) ORDER BY order_id ASC, business_id ASC, menu_id ASC`,
      [ids]
    );

    const byOrder = new Map();
    for (const o of orders) {
      o.items = [];
      byOrder.set(o.order_id, o);
    }
    for (const it of items) {
      byOrder.get(it.order_id)?.items.push(it);
    }
    return orders;
  },

  // --- legacy raw by id (kept) ---
  findById: async (order_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      WHERE o.order_id = ?
      `,
      [order_id]
    );
    if (!orders.length) return null;

    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id ASC, business_id ASC, menu_id ASC`,
      [order_id]
    );
    orders[0].items = items;
    return orders[0];
  },

  // Flat items by business (legacy/simple)
  findByBusinessId: async (business_id) => {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
      [business_id]
    );
    return items;
  },

  // Business → grouped by user (merchant dashboard use)
  findByBusinessGroupedByUser: async (business_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT DISTINCT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      INNER JOIN order_items oi
              ON oi.order_id = o.order_id
             AND oi.business_id = ?
      LEFT  JOIN users u
              ON u.user_id = o.user_id
      ORDER BY o.created_at DESC
      `,
      [business_id]
    );

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.order_id);
    const [items] = await db.query(
      `
      SELECT *
        FROM order_items
       WHERE business_id = ?
         AND order_id IN (?)
       ORDER BY order_id ASC, business_id ASC, menu_id ASC
      `,
      [business_id, orderIds]
    );

    const itemsByOrder = new Map();
    for (const it of items) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }

    const grouped = new Map(); // user_id -> { user, orders: [] }
    for (const o of orders) {
      const its = itemsByOrder.get(o.order_id) || [];
      if (!grouped.has(o.user_id)) {
        grouped.set(o.user_id, {
          user: {
            user_id: o.user_id,
            name: o.user_name || null,
            email: o.user_email || null,
            phone: o.user_phone || null,
          },
          orders: [],
        });
      }
      grouped.get(o.user_id).orders.push({
        order_id: o.order_id,
        status: o.status,
        status_reason: o.status_reason || null, // include reason
        total_amount: o.total_amount,
        discount_amount: o.discount_amount,
        payment_method: o.payment_method,
        delivery_address: o.delivery_address,
        note_for_restaurant: o.note_for_restaurant,
        fulfillment_type: o.fulfillment_type,
        priority: o.priority,
        created_at: o.created_at,
        updated_at: o.updated_at,
        items: its,
      });
    }

    return Array.from(grouped.values());
  },

  // Order → grouped shape by order_id (used earlier)
  findByOrderIdGrouped: async (order_id) => {
    const hasReason = await ensureStatusReasonSupport();

    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      LEFT JOIN users u ON u.user_id = o.user_id
      WHERE o.order_id = ?
      LIMIT 1
      `,
      [order_id]
    );
    if (!orders.length) return [];

    const [items] = await db.query(
      `
      SELECT *
      FROM order_items
      WHERE order_id = ?
      ORDER BY order_id ASC, business_id ASC, menu_id ASC
      `,
      [order_id]
    );

    const o = orders[0];
    o.items = items;

    return [
      {
        user: {
          user_id: o.user_id,
          name: o.user_name || null,
          email: o.user_email || null,
          phone: o.user_phone || null,
        },
        orders: [
          {
            order_id: o.order_id,
            status: o.status,
            status_reason: o.status_reason || null, // include reason
            total_amount: o.total_amount,
            discount_amount: o.discount_amount,
            payment_method: o.payment_method,
            delivery_address: o.delivery_address,
            note_for_restaurant: o.note_for_restaurant,
            fulfillment_type: o.fulfillment_type,
            priority: o.priority,
            created_at: o.created_at,
            updated_at: o.updated_at,
            items: o.items,
          },
        ],
      },
    ];
  },

  // === USER-FACING FETCH ===
  // Get all orders for a user_id with screen-ready shape (now includes status_reason)
  findByUserIdForApp: async (user_id) => {
    const hasReason = await ensureStatusReasonSupport();

    // 1) All orders for user
    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
        o.total_amount,
        o.discount_amount,
        o.payment_method,
        o.delivery_address,
        o.note_for_restaurant,
        o.status,
        o.fulfillment_type,
        o.priority,
        o.created_at,
        o.updated_at
      FROM orders o
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      `,
      [user_id]
    );
    if (!orders.length) return [];

    // 2) Load all items for these orders
    const orderIds = orders.map((o) => o.order_id);
    const [items] = await db.query(
      `
      SELECT
        order_id,
        business_id,
        business_name,
        menu_id,
        item_name,
        item_image,
        quantity,
        price,
        subtotal,
        platform_fee,
        delivery_fee
      FROM order_items
      WHERE order_id IN (?)
      ORDER BY order_id ASC, business_id ASC, menu_id ASC
      `,
      [orderIds]
    );

    // 3) Index items by order_id
    const itemsByOrder = new Map();
    for (const it of items) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }

    // 4) Build user-side response objects
    const result = [];
    for (const o of orders) {
      const its = itemsByOrder.get(o.order_id) || [];

      // Pick restaurant/business summary (first item wins — most orders are single-restaurant)
      const primaryBiz = its[0] || null;

      // Totals: compute from items when order.total_amount is null
      let items_subtotal = 0;
      let platform_fee_total = 0;
      let delivery_fee_total = 0;
      for (const it of its) {
        items_subtotal += Number(it.subtotal || 0);
        platform_fee_total += Number(it.platform_fee || 0);
        delivery_fee_total += Number(it.delivery_fee || 0);
      }
      const discount = Number(o.discount_amount || 0);
      const computed_total =
        items_subtotal + platform_fee_total + delivery_fee_total - discount;
      const total_amount =
        o.total_amount != null ? Number(o.total_amount) : computed_total;

      result.push({
        order_id: o.order_id,
        status: o.status,
        status_reason: o.status_reason || null, // <-- shown in user app
        payment_method: o.payment_method,
        fulfillment_type: o.fulfillment_type,
        created_at: o.created_at,

        restaurant: primaryBiz
          ? {
              business_id: primaryBiz.business_id,
              name: primaryBiz.business_name,
            }
          : null,

        deliver_to: o.delivery_address,

        totals: {
          items_subtotal,
          platform_fee: platform_fee_total,
          delivery_fee: delivery_fee_total,
          discount_amount: discount,
          total_amount,
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
  },

  update: async (order_id, orderData) => {
    if (!orderData || !Object.keys(orderData).length) return 0;
    if (orderData.status) {
      orderData.status = String(orderData.status).toUpperCase();
    }
    const fields = Object.keys(orderData);
    const values = Object.values(orderData);
    const setClause = fields.map((f) => `\`${f}\` = ?`).join(", ");

    const [result] = await db.query(
      `UPDATE orders SET ${setClause} WHERE order_id = ?`,
      [...values, order_id]
    );
    return result.affectedRows;
  },

  /** Update status (+ optional reason if column exists) */
  updateStatus: async (order_id, status, reason) => {
    const hasReason = await ensureStatusReasonSupport();
    if (hasReason) {
      const [result] = await db.query(
        `UPDATE orders SET status = ?, status_reason = ?, updated_at = NOW() WHERE order_id = ?`,
        [String(status).toUpperCase(), String(reason || "").trim(), order_id]
      );
      return result.affectedRows;
    } else {
      // Fallback: update status only
      const [result] = await db.query(
        `UPDATE orders SET status = ?, updated_at = NOW() WHERE order_id = ?`,
        [String(status).toUpperCase(), order_id]
      );
      return result.affectedRows;
    }
  },

  delete: async (order_id) => {
    const [result] = await db.query(`DELETE FROM orders WHERE order_id = ?`, [
      order_id,
    ]);
    return result.affectedRows;
  },
};

module.exports = Order;
