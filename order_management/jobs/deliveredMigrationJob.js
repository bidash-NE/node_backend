// jobs/deliveredMigrationJob.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const EmailService = require("../services/emailService");

let _timer = null;
let _running = false;

async function migrateDELIVEREDOrdersOnce({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
  delivered_by = "SYSTEM",
  reason = "Successfully delivered",
} = {}) {
  if (_running) return;
  _running = true;

  try {
    // Fetch orders that need to be migrated (not yet sent and not yet migrated)
    const [orders] = await db.query(
      `
      SELECT o.order_id, o.user_id, o.total_amount, o.created_at, o.delivered_at,
             o.payment_method, o.delivery_address, o.status, o.business_id
      FROM orders o
      LEFT JOIN receipt_email re ON o.order_id = re.order_id
      WHERE UPPER(o.status) = 'DELIVERED'
        AND o.delivered_at IS NOT NULL
        AND o.delivered_at <= (NOW() - INTERVAL 30 MINUTE)
        AND (re.order_id IS NULL OR re.email_status != 'sent')
      ORDER BY o.delivered_at ASC
      LIMIT ?
      `,
      [batchSize],
    );

    if (!orders.length) {
      console.log("[DELIVERED MIGRATION] No orders to process");
      return;
    }

    console.log(
      `[DELIVERED MIGRATION] Found ${orders.length} orders to process`,
    );

    for (const order of orders) {
      const order_id = order.order_id;
      const user_id = order.user_id;
      const business_id = order.business_id;

      try {
        // 1. Check if already in delivered_orders
        const [deliveredOrders] = await db.query(
          `SELECT order_id FROM delivered_orders WHERE order_id = ?`,
          [order_id],
        );

        // 2. Fetch user details
        const [users] = await db.query(
          `SELECT user_id, user_name, email, phone FROM users WHERE user_id = ?`,
          [user_id],
        );

        if (!users.length) {
          console.error(`[MIGRATION] User not found for order ${order_id}`);
          continue;
        }

        const user = users[0];

        // 3. Fetch items from order_items
        const [items] = await db.query(
          `SELECT oi.*, fm.item_name as menu_name
           FROM order_items oi
           LEFT JOIN food_menu fm ON oi.menu_id = fm.id
           WHERE oi.order_id = ?`,
          [order_id],
        );

        if (!items.length) {
          console.error(`[MIGRATION] No items found for order ${order_id}`);
          continue;
        }

        // 4. Get business info
        const [businesses] = await db.query(
          `SELECT business_id, business_name, business_logo, address
           FROM merchant_business_details 
           WHERE business_id = ?`,
          [business_id],
        );

        const business = businesses[0] || {};

        // 5. Parse delivery address
        let deliveryAddress = order.delivery_address || "N/A";
        if (deliveryAddress !== "N/A" && typeof deliveryAddress === "string") {
          try {
            const parsed = JSON.parse(deliveryAddress);
            deliveryAddress = parsed.address || deliveryAddress;
          } catch (e) {}
        }

        // 6. Calculate totals
        const subtotal = items.reduce((sum, item) => {
          const price = parseFloat(item.price) || 0;
          const quantity = parseInt(item.quantity) || 0;
          return sum + price * quantity;
        }, 0);

        const deliveryFee = parseFloat(order.delivery_fee) || 0;
        const platformFee = parseFloat(order.platform_fee) || 0;
        const grandTotal = parseFloat(order.total_amount) || subtotal;

        // 7. Handle business logo URL
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

        // 8. Build order data for email
        const orderData = {
          order_id: order.order_id,
          delivered_at: order.delivered_at,
          payment_method: order.payment_method,
          delivery_address: deliveryAddress,
          status: order.status || "Delivered",
          customer_name: user.user_name || "Customer",
          customer_email: user.email,
          customer_phone: user.phone || "N/A",
          business_name: business.business_name || "TabDhey",
          business_logo: businessLogo,
          business_address: business.address || "Thimphu, Bhutan",
          items: items.map((item) => ({
            menu_name: item.menu_name || `Item ${item.menu_id}`,
            quantity: parseInt(item.quantity) || 0,
            price_per_unit: parseFloat(item.price) || 0,
            subtotal:
              (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0),
          })),
          subtotal: subtotal,
          delivery_fee: deliveryFee,
          platform_fee: platformFee,
          discount_amount: 0,
          grand_total: grandTotal,
        };

        // 9. Send email receipt
        console.log(
          `[MIGRATION] Sending receipt for order ${order_id} to ${user.email}`,
        );

        const emailResult = await EmailService.sendOrderReceipt(orderData);

        if (emailResult.success) {
          // 10. Mark as sent in receipt_email table
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, user_name, business_name, receipt_sent, receipt_sent_at, email_status)
             VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), 'sent')
             ON DUPLICATE KEY UPDATE 
             receipt_sent = 1, 
             receipt_sent_at = NOW(), 
             email_status = 'sent'`,
            [
              order_id,
              user_id,
              business_id,
              user.email,
              user.user_name,
              business.business_name,
            ],
          );

          console.log(
            `[MIGRATION] Receipt sent successfully for order ${order_id}`,
          );
        } else {
          // 11. Log failed email
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, user_name, business_name, receipt_sent, email_status, error_message)
             VALUES (?, ?, ?, ?, ?, ?, 0, 'failed', ?)
             ON DUPLICATE KEY UPDATE 
             email_status = 'failed', 
             error_message = ?,
             retry_count = retry_count + 1`,
            [
              order_id,
              user_id,
              business_id,
              user.email,
              user.user_name,
              business.business_name,
              emailResult.error,
              emailResult.error,
            ],
          );

          console.error(
            `[MIGRATION] Failed to send receipt for order ${order_id}:`,
            emailResult.error,
          );

          // Skip migration if email fails (optional)
          // continue;
        }

        // 12. Move to delivered_orders if not already there
        if (!deliveredOrders.length) {
          const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
            delivered_by,
            reason,
            capture_at: "SKIP",
          });

          if (out?.ok) {
            console.log(
              `[DELIVERED MIGRATION] Order ${order_id} migrated successfully`,
            );
          }
        }
      } catch (e) {
        console.error(
          `[DELIVERED MIGRATION] Failed for order ${order_id}:`,
          e.message,
        );

        // Log error
        await db.query(
          `INSERT INTO receipt_email (order_id, error_message, email_status)
           VALUES (?, ?, 'failed')
           ON DUPLICATE KEY UPDATE 
           error_message = ?, 
           email_status = 'failed'`,
          [order_id, e.message, e.message],
        );
      }
    }
  } catch (e) {
    console.error("[DELIVERED MIGRATION] Batch error:", e.message);
  } finally {
    _running = false;
  }
}

// jobs/deliveredMigrationJob.js - Fix retryFailedEmails function

async function retryFailedEmails({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 10),
} = {}) {
  try {
    const [failedEmails] = await db.query(
      `
      SELECT order_id, user_email, business_name, order_data
      FROM receipt_email
      WHERE email_status = 'failed' 
        AND receipt_sent = 0
        AND retry_count < 3
      LIMIT ?
      `,
      [batchSize],
    );

    if (!failedEmails.length) return;

    console.log(`[RETRY] Retrying ${failedEmails.length} failed emails`);

    for (const failed of failedEmails) {
      console.log(`[RETRY] Would retry order ${failed.order_id}`);

      // Use updated_at instead of last_attempt (or just don't track last_attempt)
      await db.query(
        `UPDATE receipt_email 
         SET retry_count = retry_count + 1, 
             updated_at = NOW(),
             email_status = 'pending'
         WHERE order_id = ?`,
        [failed.order_id],
      );
    }
  } catch (e) {
    console.error("[RETRY FAILED EMAILS] Error:", e.message);
  }
}

// Cleanup DECLINED orders
async function cleanupDECLINEDOrdersOnce({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  try {
    const [rows] = await db.query(
      `
      SELECT order_id
        FROM orders
       WHERE UPPER(status) = 'DECLINED'
         AND updated_at IS NOT NULL
         AND updated_at <= (NOW() - INTERVAL 30 MINUTE)
       ORDER BY updated_at ASC
       LIMIT ?
      `,
      [batchSize],
    );

    if (!rows.length) return;

    for (const r of rows) {
      const order_id = r.order_id;
      try {
        await db.query(`DELETE FROM order_items WHERE order_id = ?`, [
          order_id,
        ]);
        await db.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);
        console.log("[DECLINED CLEANUP] deleted:", { order_id });
      } catch (e) {
        console.error("[DECLINED CLEANUP] failed:", {
          order_id,
          err: e?.message,
        });
      }
    }
  } catch (e) {
    console.error("[DECLINED CLEANUP] batch error:", e?.message);
  }
}

function startDeliveredMigrationJob({
  intervalMs = Number(process.env.DELIVERED_MIGRATION_INTERVAL_MS || 60000),
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  // Run immediately on server start
  migrateDELIVEREDOrdersOnce({ batchSize });
  cleanupDECLINEDOrdersOnce({ batchSize });

  // Run every interval
  _timer = setInterval(() => {
    migrateDELIVEREDOrdersOnce({ batchSize });
    cleanupDECLINEDOrdersOnce({ batchSize });
    retryFailedEmails({ batchSize: 10 });
  }, intervalMs);

  console.log(
    `✅ Delivered migration with auto email started (every ${intervalMs / 1000}s, batchSize=${batchSize})`,
  );

  const stop = () => {
    if (_timer) clearInterval(_timer);
    _timer = null;
    console.log("🛑 Delivered migration job stopped");
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = {
  startDeliveredMigrationJob,
  migrateDELIVEREDOrdersOnce,
  cleanupDECLINEDOrdersOnce,
  retryFailedEmails,
};
