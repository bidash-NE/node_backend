// models/orderModels.js
const db = require("../config/db");

function generateOrderId() {
  const randomNum = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${randomNum}`;
}

const Order = {
  create: async (orderData) => {
    const order_id = generateOrderId();

    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      total_amount: orderData.total_amount,
      discount_amount: orderData.discount_amount,
      payment_method: orderData.payment_method,
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
    const [orders] = await db.query(
      `SELECT * FROM orders ORDER BY created_at DESC`
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

  // Legacy raw-by-id (kept; not used by controller anymore)
  findById: async (order_id) => {
    const [orders] = await db.query(`SELECT * FROM orders WHERE order_id = ?`, [
      order_id,
    ]);
    if (!orders.length) return null;

    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id ASC, business_id ASC, menu_id ASC`,
      [order_id]
    );
    orders[0].items = items;
    return orders[0];
  },

  // Flat list of items for a business (legacy/simple)
  findByBusinessId: async (business_id) => {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
      [business_id]
    );
    return items;
  },

  // Orders for a business, grouped by user with user name and items for that business only
  findByBusinessGroupedByUser: async (business_id) => {
    const [orders] = await db.query(
      `
      SELECT DISTINCT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
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

    for (const o of orders) {
      o.items = itemsByOrder.get(o.order_id) || [];
    }

    const grouped = new Map(); // user_id -> { user, orders: [] }
    for (const o of orders) {
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
      });
    }

    return Array.from(grouped.values());
  },

  /**
   * NEW: Same grouped-by-user shape but fetched by order_id.
   * Returns [] if not found, or:
   * [
   *   {
   *     user: { user_id, name, email, phone },
   *     orders: [ { ...orderFields, items: [...] } ]
   *   }
   * ]
   */
  findByOrderIdGrouped: async (order_id) => {
    const [orders] = await db.query(
      `
      SELECT
        o.order_id,
        o.user_id,
        u.user_name AS user_name,
        u.email     AS user_email,
        u.phone     AS user_phone,
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

    // group into the same structure used by findByBusinessGroupedByUser
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

  updateStatus: async (order_id, status) => {
    const [result] = await db.query(
      `UPDATE orders SET status = ?, updated_at = NOW() WHERE order_id = ?`,
      [String(status).toUpperCase(), order_id]
    );
    return result.affectedRows;
  },

  delete: async (order_id) => {
    const [result] = await db.query(`DELETE FROM orders WHERE order_id = ?`, [
      order_id,
    ]);
    return result.affectedRows;
  },
};

module.exports = Order;
