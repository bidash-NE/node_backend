// jobs/pickedupMigrationJob.js
const db = require("../config/db");
const PickupEmailService = require("../services/pickupEmailService");

let _timer = null;
let _running = false;

async function retryFailedPickupEmails({
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 10),
} = {}) {
  try {
    const [failedEmails] = await db.query(
      `
      SELECT order_id, user_email, business_name, error_message
      FROM receipt_email
      WHERE email_status = 'failed' 
        AND receipt_sent = 0
        AND retry_count < 3
        AND delivery_method = 'PICKUP'
      LIMIT ?
      `,
      [batchSize],
    );

    if (!failedEmails.length) return;

    console.log(
      `[PICKUP RETRY] Retrying ${failedEmails.length} failed PICKUP emails`,
    );

    for (const failed of failedEmails) {
      console.log(`[PICKUP RETRY] Retrying order ${failed.order_id}`);

      try {
        const [orders] = await db.query(
          `SELECT po.*, u.user_name, u.email, u.phone, 
                  mbd.business_logo, mbd.address as business_address
           FROM pickedup_orders po
           JOIN users u ON po.user_id = u.user_id
           LEFT JOIN merchant_business_details mbd ON po.business_id = mbd.business_id
           WHERE po.order_id = ?`,
          [failed.order_id],
        );

        if (!orders.length) {
          console.log(`[PICKUP RETRY] Order ${failed.order_id} not found`);
          continue;
        }

        const order = orders[0];

        const [items] = await db.query(
          `SELECT * FROM pickedup_order_items WHERE order_id = ?`,
          [failed.order_id],
        );

        const subtotal = items.reduce(
          (sum, item) => sum + (parseFloat(item.subtotal) || 0),
          0,
        );
        const grandTotal = parseFloat(order.total_amount) || subtotal;

        let businessLogo = null;
        if (order.business_logo) {
          let logo = order.business_logo;
          if (logo.startsWith("/uploads/")) {
            businessLogo = `https://backend.tabdhey.bt/merchant${logo}`;
          } else if (logo.startsWith("http")) {
            businessLogo = logo;
          }
        }

        const orderData = {
          order_id: order.order_id,
          created_at: order.original_created_at,
          pickedup_at: order.pickedup_at,
          payment_method: order.payment_method,
          pickup_address: order.pickup_address,
          customer_name: order.user_name,
          customer_email: order.email,
          customer_phone: order.phone,
          business_name: order.business_name,
          business_logo: businessLogo,
          business_address: order.business_address,
          items: items.map((item) => ({
            menu_name: item.item_name,
            quantity: item.quantity,
            price_per_unit: item.price,
            subtotal: item.subtotal,
          })),
          subtotal: subtotal,
          grand_total: grandTotal,
        };

        const emailResult =
          await PickupEmailService.sendPickupReceipt(orderData);

        if (emailResult.success) {
          await db.query(
            `UPDATE receipt_email 
             SET receipt_sent = 1, receipt_sent_at = NOW(), email_status = 'sent', error_message = NULL
             WHERE order_id = ? AND delivery_method = 'PICKUP'`,
            [failed.order_id],
          );
          console.log(
            `[PICKUP RETRY] ✅ Email resent successfully for ${failed.order_id}`,
          );
        } else {
          await db.query(
            `UPDATE receipt_email 
             SET retry_count = retry_count + 1, updated_at = NOW(), error_message = ?
             WHERE order_id = ? AND delivery_method = 'PICKUP'`,
            [emailResult.error, failed.order_id],
          );
          console.log(
            `[PICKUP RETRY] ❌ Failed again for ${failed.order_id}: ${emailResult.error}`,
          );
        }
      } catch (error) {
        console.error(
          `[PICKUP RETRY] Error for ${failed.order_id}:`,
          error.message,
        );
        await db.query(
          `UPDATE receipt_email 
           SET retry_count = retry_count + 1, updated_at = NOW(), error_message = ?
           WHERE order_id = ? AND delivery_method = 'PICKUP'`,
          [error.message, failed.order_id],
        );
      }
    }
  } catch (e) {
    console.error("[PICKUP RETRY] Batch error:", e.message);
  }
}

async function migratePICKEDUPOrdersOnce({
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 50),
} = {}) {
  if (_running) return;
  _running = true;

  try {
    // In pickedupMigrationJob.js
    const [rows] = await db.query(
      `
  SELECT o.order_id, o.user_id, o.total_amount, o.created_at, 
         o.payment_method, o.delivery_address, o.status, o.business_id,
         o.updated_at, o.discount_amount, o.pickedup_by, o.pickedup_at
  FROM orders o
  LEFT JOIN pickedup_orders pu ON o.order_id = pu.order_id
  WHERE UPPER(o.status) = 'PICKEDUP'
    AND o.pickedup_at IS NOT NULL
    AND o.pickedup_at <= (NOW() - INTERVAL 30 MINUTE)  -- Wait 30 minutes before migrating
    AND pu.order_id IS NULL
  ORDER BY o.pickedup_at ASC
  LIMIT ?
  `,
      [batchSize],
    );

    if (!rows.length) {
      console.log("[PICKEDUP MIGRATION] No orders to process");
      return;
    }

    console.log(`[PICKEDUP MIGRATION] Found ${rows.length} orders to process`);

    for (const order of rows) {
      const order_id = order.order_id;

      if (!order_id) {
        console.error("[PICKEDUP MIGRATION] Skipping: order_id is null");
        continue;
      }

      try {
        console.log(`[PICKEDUP MIGRATION] Processing order ${order_id}`);

        const [businesses] = await db.query(
          `SELECT business_id, business_name, address, business_logo
           FROM merchant_business_details 
           WHERE business_id = ?`,
          [order.business_id],
        );

        const business = businesses[0] || {};

        const [users] = await db.query(
          `SELECT user_id, user_name, email, phone FROM users WHERE user_id = ?`,
          [order.user_id],
        );

        const user = users[0] || {};

        const [items] = await db.query(
          `SELECT oi.*, COALESCE(fm.item_name, 'Item') as menu_name
           FROM order_items oi
           LEFT JOIN food_menu fm ON oi.menu_id = fm.id
           WHERE oi.order_id = ?`,
          [order_id],
        );

        if (!items.length) {
          console.error(
            `[PICKEDUP MIGRATION] No items found for order ${order_id}`,
          );
          continue;
        }

        const subtotal = items.reduce((sum, item) => {
          const price = parseFloat(item.price) || 0;
          const quantity = parseInt(item.quantity) || 0;
          return sum + price * quantity;
        }, 0);

        const grandTotal = parseFloat(order.total_amount) || subtotal;

        let businessLogo = null;
        if (business.business_logo) {
          let logo = business.business_logo;
          if (logo.startsWith("/uploads/")) {
            businessLogo = `https://backend.tabdhey.bt/merchant${logo}`;
          } else if (logo.startsWith("http")) {
            businessLogo = logo;
          } else {
            businessLogo = `https://backend.tabdhey.bt/merchant/uploads/logos/${logo}`;
          }
        }

        let pickupAddress = order.delivery_address || business.address || "N/A";
        if (pickupAddress !== "N/A" && typeof pickupAddress === "string") {
          try {
            const parsed = JSON.parse(pickupAddress);
            pickupAddress = parsed.address || pickupAddress;
          } catch (e) {}
        }

        const orderData = {
          order_id: order.order_id,
          created_at: order.created_at,
          pickedup_at: order.pickedup_at || new Date(),
          payment_method: order.payment_method,
          pickup_address: pickupAddress,
          status: "PICKEDUP",
          customer_name: user.user_name || "Customer",
          customer_email: user.email,
          customer_phone: user.phone || "N/A",
          business_name: business.business_name || "TabDhey",
          business_logo: businessLogo,
          business_address: business.address || "Thimphu, Bhutan",
          items: items.map((item) => ({
            menu_name: item.menu_name,
            quantity: parseInt(item.quantity) || 0,
            price_per_unit: parseFloat(item.price) || 0,
            subtotal:
              (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0),
          })),
          subtotal: subtotal,
          grand_total: grandTotal,
        };

        console.log(
          `[PICKEDUP MIGRATION] Sending pickup email to ${user.email}...`,
        );
        const emailResult =
          await PickupEmailService.sendPickupReceipt(orderData);

        if (emailResult.success) {
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, user_name, business_name, receipt_sent, receipt_sent_at, email_status, delivery_method)
             VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), 'sent', 'PICKUP')
             ON DUPLICATE KEY UPDATE 
             receipt_sent = 1, receipt_sent_at = NOW(), email_status = 'sent', delivery_method = 'PICKUP'`,
            [
              order_id,
              order.user_id,
              order.business_id,
              user.email,
              user.user_name,
              business.business_name,
            ],
          );
          console.log(
            `[PICKEDUP MIGRATION] ✅ Email sent for order ${order_id}`,
          );
        } else {
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, email_status, error_message, delivery_method, retry_count)
             VALUES (?, ?, ?, ?, 'failed', ?, 'PICKUP', 0)
             ON DUPLICATE KEY UPDATE 
             email_status = 'failed', error_message = ?, delivery_method = 'PICKUP', retry_count = retry_count + 1`,
            [
              order_id,
              order.user_id,
              order.business_id,
              user.email,
              emailResult.error,
              emailResult.error,
            ],
          );
          console.error(
            `[PICKEDUP MIGRATION] ❌ Email failed for order ${order_id}:`,
            emailResult.error,
          );
        }

        await db.query(
          `INSERT INTO pickedup_orders (
            order_id, user_id, business_id, business_name, status,
            total_amount, discount_amount, payment_method, pickup_address,
            pickedup_by, pickedup_at, original_created_at, original_updated_at
          ) VALUES (?, ?, ?, ?, 'PICKEDUP', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            order_id,
            order.user_id,
            order.business_id,
            business.business_name || "Unknown Business",
            order.total_amount,
            order.discount_amount || 0,
            order.payment_method,
            pickupAddress,
            order.pickedup_by || user.user_name || "CUSTOMER",
            order.pickedup_at || new Date(),
            order.created_at,
            order.updated_at,
          ],
        );

        for (const item of items) {
          const subtotal =
            (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0);

          await db.query(
            `INSERT INTO pickedup_order_items (
              order_id, business_id, business_name, menu_id, item_name,
              item_image, quantity, price, subtotal
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              order_id,
              item.business_id || order.business_id,
              business.business_name || "Unknown Business",
              item.menu_id,
              item.menu_name || `Item ${item.menu_id}`,
              item.item_image || null,
              item.quantity,
              item.price,
              subtotal,
            ],
          );
        }

        await db.query(`DELETE FROM order_items WHERE order_id = ?`, [
          order_id,
        ]);
        await db.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);

        console.log(
          `[PICKEDUP MIGRATION] ✅ Successfully migrated order ${order_id}`,
        );
      } catch (e) {
        console.error(
          `[PICKEDUP MIGRATION] ❌ Failed for order ${order_id}:`,
          e.message,
        );
      }
    }
  } catch (e) {
    console.error("[PICKEDUP MIGRATION] Batch error:", e.message);
  } finally {
    _running = false;
  }
}

function startPickedupMigrationJob({
  intervalMs = Number(process.env.PICKEDUP_MIGRATION_INTERVAL_MS || 60000),
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  console.log(`🚀 Starting Pickedup Migration Job...`);
  console.log(`   Interval: ${intervalMs / 1000}s`);
  console.log(`   Batch Size: ${batchSize}`);

  migratePICKEDUPOrdersOnce({ batchSize }).catch(console.error);

  _timer = setInterval(() => {
    migratePICKEDUPOrdersOnce({ batchSize }).catch(console.error);
    retryFailedPickupEmails({ batchSize: 10 }).catch(console.error);
  }, intervalMs);

  console.log(`✅ Pickedup migration job started`);

  const stop = () => {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
      console.log("🛑 Pickedup migration job stopped");
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = {
  startPickedupMigrationJob,
  migratePICKEDUPOrdersOnce,
  retryFailedPickupEmails,
};
