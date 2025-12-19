// server.js (UPDATED - Orders Service)
const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const { startDeliveredMigrationJob } = require("./jobs/deliveredMigrationJob");

const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime"); // socket attach
const notificationRoutes = require("./routes/notificationRoutes");
const usernotificationRoutes = require("./routes/userNotificationRoutes");
const scheduledOrdersRoutes = require("./routes/scheduledOrdersRoutes");
const cancelledOrderRoutes = require("./routes/cancelledOrderRoutes");
const deliveredOrderRoutes = require("./routes/deliveredOrderRoutes");
const {
  startScheduledOrderProcessor,
} = require("./services/scheduledOrderProcessor");

// auto-cancel pending orders
const {
  startPendingOrderAutoCanceller,
} = require("./services/autoCancelPendingOrders");

dotenv.config();

const app = express();

/* ===================== CORS ===================== */
/**
 * If you're NOT using cookies, set credentials:false.
 * If you are using cookies/auth sessions, keep credentials:true and set a specific origin.
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

/* ===================== Body parsing ===================== */
/**
 * IMPORTANT:
 * - We support application/json for normal requests.
 * - For multipart/form-data (image upload), multer handles it in route middleware.
 */
app.use(express.json({ limit: "2mb" }));

/* ===================== Uploads static ===================== */
/**
 * ✅ CRITICAL FIX:
 * Use the SAME UPLOAD_ROOT across:
 * 1) multer destination (in uploadDeliveryPhoto middleware)
 * 2) express.static here
 *
 * We use:
 * - process.env.UPLOAD_ROOT if provided
 * - else default: <project_root>/uploads   (process.cwd())
 */
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// Ensure root exists so express.static doesn't point to nowhere
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Serve uploaded files publicly
app.use("/uploads", express.static(UPLOAD_ROOT));

// Helpful log
console.log("✅ Orders UPLOAD_ROOT:", UPLOAD_ROOT);

/* ===================== Optional static test pages ===================== */
/**
 * This serves files inside ./public at:
 * - http://localhost:<PORT>/<filename>
 * Example: ./public/index.html -> http://localhost:1001/index.html
 */
app.use(express.static(path.join(__dirname, "public")));

/* ===================== Health ===================== */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ===================== REST routes ===================== */
app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);
app.use("/api/user_notification", usernotificationRoutes);
app.use("/api", scheduledOrdersRoutes);
app.use("/cancelled", cancelledOrderRoutes);
app.use("/api/delivered-orders", deliveredOrderRoutes);

/* ===================== Error handler ===================== */
/**
 * This will surface multer errors nicely too.
 */
app.use((err, _req, res, _next) => {
  console.error("❌ Error:", err);

  const status = err.statusCode || err.status || 500;
  const msg =
    err.message || "Something went wrong. Check server logs for more details.";

  res.status(status).json({
    success: false,
    message: msg,
  });
});

/* ===================== HTTP server (REST + Socket.IO) ===================== */
const server = http.createServer(app);

(async () => {
  try {
    await initOrderManagementTable();

    // Attach socket handlers to SAME server (important)
    await attachRealtime(server);

    // background services
    startScheduledOrderProcessor();
    startPendingOrderAutoCanceller();

    startDeliveredMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    const PORT = Number(process.env.PORT || 1001);
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Order service + Realtime listening on port :${PORT}`);
      console.log(`📦 Uploads served at: http://localhost:${PORT}/uploads/...`);
    });
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();
