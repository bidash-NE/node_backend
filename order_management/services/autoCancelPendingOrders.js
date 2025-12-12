// services/autoCancelPendingOrders.js
const db = require("../config/db");
const Order = require("../models/orderModels");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

/**
 * Auto-cancel any order that remains PENDING longer than N minutes.
 *
 * ENV (optional):
 *  - AUTO_CANCEL_PENDING_ORDERS=true|false   (default true)
 *  - PENDING_ORDER_TIMEOUT_MINUTES=60       (default 60)
 *  - PENDING_ORDER_SCAN_INTERVAL_SECONDS=60 (default 60)
 *  - PENDING_ORDER_SCAN_LIMIT=200           (default 200)
 */
function startPendingOrderAutoCanceller() {
  const enabled =
    String(process.env.AUTO_CANCEL_PENDING_ORDERS ?? "true")
      .trim()
      .toLowerCase() !== "false";

  if (!enabled) {
    console.log(
      "⏸️ Pending-order auto-canceller is disabled (AUTO_CANCEL_PENDING_ORDERS=false)"
    );
    return { stop: () => {} };
  }

  const timeoutMinutes = Math.max(
    1,
    Number(process.env.PENDING_ORDER_TIMEOUT_MINUTES || 60)
  );

  const intervalSeconds = Math.max(
    15,
    Number(process.env.PENDING_ORDER_SCAN_INTERVAL_SECONDS || 60)
  );

  const limit = Math.max(
    1,
    Number(process.env.PENDING_ORDER_SCAN_LIMIT || 200)
  );

  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;

    try {
      // Find PENDING orders older than timeoutMinutes
      const [rows] = await db.query(
        `
        SELECT o.order_id, o.user_id, o.created_at
          FROM orders o
         WHERE o.status = 'PENDING'
           AND o.created_at <= (NOW() - INTERVAL ? MINUTE)
         ORDER BY o.created_at ASC
         LIMIT ?
        `,
        [timeoutMinutes, limit]
      );

      if (!rows.length) return;

      for (const r of rows) {
        const order_id = String(r.order_id);
        const user_id = Number(r.user_id);

        const reason = `Auto-cancelled: store did not accept within ${timeoutMinutes} minutes.`;

        // Cancel only if it's STILL PENDING (prevents race conditions)
        const cancelled = await Order.cancelIfStillPending(order_id, reason);
        if (!cancelled) continue;

        // Get business ids for this order (for merchant notifications + broadcast)
        const [bizRows] = await db.query(
          `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
          [order_id]
        );
        const business_ids = bizRows.map((x) => x.business_id);

        // Broadcast to user + merchants
        broadcastOrderStatusToMany({
          order_id,
          user_id,
          business_ids,
          status: "CANCELLED",
        });

        // Merchant notification(s)
        for (const business_id of business_ids) {
          try {
            await insertAndEmitNotification({
              business_id,
              user_id,
              order_id,
              type: "order:status",
              title: `Order #${order_id} CANCELLED`,
              body_preview: reason,
            });
          } catch (e) {
            console.error("[AUTO_CANCEL notify merchant failed]", {
              order_id,
              business_id,
              err: e?.message,
            });
          }
        }

        // User notification
        try {
          await Order.addUserOrderStatusNotification({
            user_id,
            order_id,
            status: "CANCELLED",
            reason,
          });
        } catch (e) {
          console.error("[AUTO_CANCEL notify user failed]", {
            order_id,
            user_id,
            err: e?.message,
          });
        }

        console.log(
          `🧹 Auto-cancelled order ${order_id} (PENDING > ${timeoutMinutes}m)`
        );
      }
    } catch (e) {
      console.error("[AUTO_CANCEL runOnce ERROR]", e?.message || e);
    } finally {
      running = false;
    }
  };

  // run immediately + on interval
  runOnce();
  const timer = setInterval(runOnce, intervalSeconds * 1000);

  // allow process to exit normally
  if (typeof timer.unref === "function") timer.unref();

  console.log(
    `✅ Pending-order auto-canceller started: timeout=${timeoutMinutes}m, scan_every=${intervalSeconds}s`
  );

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = { startPendingOrderAutoCanceller };
