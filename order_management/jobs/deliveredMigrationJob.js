// jobs/deliveredMigrationJob.js
const db = require("../config/db");
const Order = require("../models/orderModels");

let _timer = null;
let _running = false;

async function migrateDELIVEREDOrdersOnce({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
  delivered_by = "SYSTEM",
  reason = "Successsfully delivered",
} = {}) {
  if (_running) return;
  _running = true;

  try {
    // Grab a batch of DELIVERED orders still sitting in main tables
    const [rows] = await db.query(
      `
  SELECT order_id
    FROM orders
   WHERE UPPER(status) = 'DELIVERED'
     AND delivered_at IS NOT NULL
     AND delivered_at <= (NOW() - INTERVAL 30 MINUTE)
   ORDER BY delivered_at ASC
   LIMIT ?
  `,
      [batchSize],
    );

    if (!rows.length) return;

    for (const r of rows) {
      const order_id = r.order_id;
      try {
        // This will:
        // - ensure status=DELIVERED
        // - archive to delivered_*
        // - delete from orders + order_items
        // - trim delivered to latest 10 for that user (if you added it there)
        const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
          delivered_by,
          reason,
        });

        if (!out?.ok) {
          console.log("[DELIVERED MIGRATION] skipped:", {
            order_id,
            code: out?.code,
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
