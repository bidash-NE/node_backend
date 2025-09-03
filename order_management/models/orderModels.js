const db = require("../config/db");

function generateOrderId() {
  const randomNum = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${randomNum}`;
}

const Order = {
  create: async (orderData) => {
    const order_id = generateOrderId();
    // Insert into orders table
    await db.query(`INSERT INTO orders SET ?`, {
      order_id,
      user_id: orderData.user_id,
      total_amount: orderData.total_amount,
      discount_amount: orderData.discount_amount,
      payment_method: orderData.payment_method,
      delivery_address: orderData.delivery_address,
      note_for_restaurant: orderData.note_for_restaurant,
      status: orderData.status || "PENDING",
      fulfillment_type: orderData.fulfillment_type || "Delivery",
      priority: orderData.priority || false,
    });
    // Insert items
    for (const item of orderData.items) {
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
    const [orders] = await db.query(`SELECT * FROM orders`);
    for (const order of orders) {
      const [items] = await db.query(
        `SELECT * FROM order_items WHERE order_id = ?`,
        [order.order_id]
      );
      order.items = items;
    }
    return orders;
  },

  findById: async (order_id) => {
    const [orders] = await db.query(`SELECT * FROM orders WHERE order_id = ?`, [
      order_id,
    ]);
    if (!orders.length) return null;
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id = ?`,
      [order_id]
    );
    orders[0].items = items;
    return orders[0];
  },

  findByBusinessId: async (business_id) => {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE business_id = ?`,
      [business_id]
    );
    // Optionally, group by order_id
    return items;
  },

  update: async (order_id, orderData) => {
    // Build SET clause dynamically
    const fields = Object.keys(orderData);
    const values = Object.values(orderData);
    const setClause = fields.map((field) => `\`${field}\` = ?`).join(", ");

    const [result] = await db.query(
      `UPDATE orders SET ${setClause} WHERE order_id = ?`,
      [...values, order_id]
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
