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
        const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
          delivered_by,
          reason,
          capture_at: "SKIP", // ✅ IMPORTANT
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

          // decrement stock for each delivered item (migration-only, in-job)
          try {
            const [items] = await db.query(
              `SELECT menu_id, quantity, business_id FROM delivered_order_items WHERE order_id = ?`,
              [order_id],
            );

            if (Array.isArray(items) && items.length) {
              for (const it of items) {
                try {
                  const menuId = Number(it.menu_id);
                  const qty = Number(it.quantity || 0);
                  const businessId = Number(it.business_id || 0);
                  if (!menuId || qty <= 0 || !businessId) continue;

                  // get owner_type from merchant_business_details
                  const [[mb]] = await db.query(
                    `SELECT owner_type FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
                    [businessId],
                  );
                  const ownerType = mb?.owner_type
                    ? String(mb.owner_type).trim().toUpperCase()
                    : null;

                  const table =
                    ownerType === "MART" ||
                    (ownerType && ownerType.toLowerCase().includes("mart"))
                      ? "mart_menu"
                      : "food_menu";

                  try {
                    await db.query(
                      `UPDATE ${table}
                         SET stock_limit = GREATEST(IFNULL(stock_limit,0) - ?, 0), updated_at = NOW()
                       WHERE id = ? AND business_id = ?`,
                      [qty, menuId, businessId],
                    );
                  } catch (e) {
                    console.error("[DELIVERED MIGRATION] stock update failed", {
                      order_id,
                      menuId,
                      qty,
                      businessId,
                      table,
                      err: e?.message || e,
                    });
                  }
                } catch (e) {
                  console.error("[DELIVERED MIGRATION] item processing error", {
                    order_id,
                    item: it,
                    err: e?.message || e,
                  });
                }
              }
            }
          } catch (e) {
            console.error(
              "[DELIVERED MIGRATION] fetch delivered items failed:",
              e?.message || e,
            );
          }
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
        // Delete order items first (foreign key constraint)
        await db.query(`DELETE FROM order_items WHERE order_id = ?`, [
          order_id,
        ]);

        // Then delete order
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
  intervalMs = Number(process.env.DELIVERED_MIGRATION_INTERVAL_MS || 60_000),
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  // Run once immediately on server start
  migrateDELIVEREDOrdersOnce({ batchSize }).catch(() => {});
  cleanupDECLINEDOrdersOnce({ batchSize }).catch(() => {});

  // Then every 1 minute (default)
  _timer = setInterval(() => {
    migrateDELIVEREDOrdersOnce({ batchSize }).catch(() => {});
    cleanupDECLINEDOrdersOnce({ batchSize }).catch(() => {});
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
  cleanupDECLINEDOrdersOnce,
};
