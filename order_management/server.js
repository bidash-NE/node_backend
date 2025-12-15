// server.js
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const { startDeliveredMigrationJob } = require("./jobs/deliveredMigrationJob");

const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime"); // <- socket attach
const notificationRoutes = require("./routes/notificationRoutes");
const usernotificationRoutes = require("./routes/userNotificationRoutes");
const scheduledOrdersRoutes = require("./routes/scheduledOrdersRoutes");
const cancelledOrderRoutes = require("./routes/cancelledOrderRoutes");
const deliveredOrderRoutes = require("./routes/deliveredOrderRoutes");
const {
  startScheduledOrderProcessor,
} = require("./services/scheduledOrderProcessor");

// ✅ NEW: auto-cancel pending orders
const {
  startPendingOrderAutoCanceller,
} = require("./services/autoCancelPendingOrders");

dotenv.config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// serve simple test pages (optional)
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// REST routes
app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);
app.use("/api/user_notification", usernotificationRoutes);
app.use("/api", scheduledOrdersRoutes);
app.use("/cancelled", cancelledOrderRoutes);
app.use("/api/delivered-orders", deliveredOrderRoutes);

// single HTTP server for REST + Socket.IO
const server = http.createServer(app);

(async () => {
  try {
    await initOrderManagementTable();

    await attachRealtime(server);

    startScheduledOrderProcessor();
    startPendingOrderAutoCanceller();

    startDeliveredMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    const PORT = Number(process.env.PORT || 3000);
    server.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 Order service + Realtime listening on :${PORT}`)
    );
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();
