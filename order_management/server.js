// server.js (UPDATED - Orders Service)

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const { startDeliveredMigrationJob } = require("./jobs/deliveredMigrationJob");
const { startPickedupMigrationJob } = require("./jobs/pickedupMigrationJob");

const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime");

const notificationRoutes = require("./routes/notificationRoutes");
const usernotificationRoutes = require("./routes/userNotificationRoutes");
const scheduledOrdersRoutes = require("./routes/scheduledOrdersRoutes");
const cancelledOrderRoutes = require("./routes/cancelledOrderRoutes");
const deliveredOrderRoutes = require("./routes/deliveredOrderRoutes");

const {
  startScheduledOrderProcessor,
} = require("./services/scheduledOrderProcessor");

// Auto-cancel normal pending orders
const {
  startPendingOrderAutoCanceller,
} = require("./services/autoCancelPendingOrders");

// ✅ Scheduled-order cleanup service:
// handles expired PENDING, expired REJECTED, and old legacy scheduled_orders queue
const {
  cleanupScheduledOrders,
} = require("./services/scheduledOrderCleanupService");

dotenv.config();

const app = express();

app.set("trust proxy", 1);

/* ===================== CORS ===================== */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  }),
);

/* ===================== Body parsing ===================== */

app.use(express.json({ limit: "2mb" }));

/* ===================== Uploads static ===================== */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

app.use("/uploads", express.static(UPLOAD_ROOT));

console.log("✅ Orders UPLOAD_ROOT:", UPLOAD_ROOT);

/* ===================== Optional static test pages ===================== */

app.use(express.static(path.join(__dirname, "public")));

/* ===================== Health ===================== */

app.get("/health", (_req, res) => {
  return res.json({ ok: true });
});

/* ===================== REST routes ===================== */

app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);
app.use("/api/user_notification", usernotificationRoutes);
app.use("/api", scheduledOrdersRoutes);
app.use("/cancelled", cancelledOrderRoutes);
app.use("/api/delivered-orders", deliveredOrderRoutes);

/* ===================== Error handler ===================== */

app.use((err, _req, res, _next) => {
  console.error("❌ Error:", err);

  const status = err.statusCode || err.status || 500;
  const msg =
    err.message || "Something went wrong. Check server logs for more details.";

  return res.status(status).json({
    success: false,
    message: msg,
  });
});

/* ===================== HTTP server REST + Socket.IO ===================== */

const server = http.createServer(app);

(async () => {
  try {
    await initOrderManagementTable();

    // Attach socket handlers to the same server
    await attachRealtime(server);

    /* ===================== Background services ===================== */

    // 1. Process accepted scheduled orders from scheduled_orders_accepted
    startScheduledOrderProcessor();

    // 2. Auto-cancel normal pending orders, unrelated to scheduled_orders_pending
    startPendingOrderAutoCanceller();

    // 3. Delivered migration
    startDeliveredMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    // 4. Picked-up migration
    startPickedupMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    // 5. Scheduled-order cleanup:
    //    - deletes expired PENDING scheduled orders after 30 minutes
    //    - deletes expired REJECTED scheduled orders after 30 minutes
    //    - migrates/cleans old legacy scheduled_orders ZSET
    await cleanupScheduledOrders();

    setInterval(() => {
      cleanupScheduledOrders().catch((err) => {
        console.error("❌ Scheduled orders cleanup interval error:", err);
      });
    }, 60_000);

    console.log(
      "🧹 Scheduled orders cleanup started: pending + rejected + legacy (1 min interval)",
    );

    /* ===================== Start server ===================== */

    const PORT = Number(process.env.PORT || 1001);

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `🚀 Order service + Realtime listening on port number :${PORT}`,
      );
      console.log(`📦 Uploads served at: http://localhost:${PORT}/uploads/...`);
    });
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();