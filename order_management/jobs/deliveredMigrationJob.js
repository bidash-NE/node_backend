// jobs/deliveredMigrationJob.js
const db = require("../config/db");
const Order = require("../models/orderModels");

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
    // ✅ Only migrate orders that:
    // - status = DELIVERED
    // - delivered_at older than 30 mins
    // - AND if WALLET/COD => capture record exists (so migration never blocks on capture)
    const [rows] = await db.query(
      `
      SELECT o.order_id
        FROM orders o
        LEFT JOIN order_wallet_captures cw
          ON cw.order_id = o.order_id AND cw.capture_type = 'WALLET_FULL'
        LEFT JOIN order_wallet_captures cc
          ON cc.order_id = o.order_id AND cc.capture_type = 'COD_FEE'
       WHERE UPPER(o.status) = 'DELIVERED'
         AND o.delivered_at IS NOT NULL
         AND o.delivered_at <= (NOW() - INTERVAL 30 MINUTE)
         AND (
           (UPPER(o.payment_method) = 'WALLET' AND cw.order_id IS NOT NULL) OR
           (UPPER(o.payment_method) = 'COD'    AND cc.order_id IS NOT NULL) OR
           (UPPER(o.payment_method) NOT IN ('WALLET','COD'))
         )
       ORDER BY o.delivered_at ASC
       LIMIT ?
      `,
      [batchSize],
    );

    if (!rows.length) return;

    for (const r of rows) {
      const order_id = r.order_id;

      try {
        // ✅ IMPORTANT:
        // Skip capture during migration — capture already happened at delivery.
        const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
          delivered_by,
          reason,
          capture_at: "SKIP", // anything != "DELIVERED"
        });

        if (!out?.ok) {
          console.log("[DELIVERED MIGRATION] skipped:", {
            order_id,
            code: out?.code,
            error: out?.error,
            current_status: out?.current_status,
          });
        } else {
          console.log("[DELIVERED MIGRATION] migrated:", {
            order_id,
            user_id: out.user_id,
          });
        }
      } catch (e) {
        console.error("[DELIVERED MIGRATION] failed:", {
          order_id,
          err: e?.message,
        });
      }
    }
  } catch (e) {
    console.error("[DELIVERED MIGRATION] batch error:", e?.message);
  } finally {
    _running = false;
  }
}

function startDeliveredMigrationJob({
  intervalMs = Number(process.env.DELIVERED_MIGRATION_INTERVAL_MS || 60_000),
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  // Run once immediately on server start
  migrateDELIVEREDOrdersOnce({ batchSize }).catch(() => {});

  // Then every 1 minute (default)
  _timer = setInterval(() => {
    migrateDELIVEREDOrdersOnce({ batchSize }).catch(() => {});
  }, intervalMs);

  console.log(
    `✅ Delivered migration job started (every ${Math.round(
      intervalMs / 1000,
    )}s, batchSize=${batchSize})`,
  );

  // Optional: graceful stop
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
};
