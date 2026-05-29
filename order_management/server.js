// server.js (UPDATED - Orders Service with Prisma)

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load env (MUST BE FIRST)
dotenv.config();

// ✅ Handle BigInt serialization globally
BigInt.prototype.toJSON = function() {
  return Number(this);
};

// Import Prisma
const { prisma } = require("./lib/prisma");

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

// ✅ Scheduled-order cleanup service
const {
  cleanupScheduledOrders,
} = require("./services/scheduledOrderCleanupService");

const app = express();

app.set("trust proxy", 1);

// Test Prisma connection
async function testPrismaConnection() {
  try {
    await prisma.$connect();
    console.log("✅ Prisma connected to database successfully!");
    
    // Optional: Test a simple query
    const result = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log("✅ Database connection verified");
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);
    if (error.message.includes("Access denied")) {
      console.error("   Please check your database username and password in .env file");
    } else if (error.message.includes("Unknown database")) {
      console.error("   Please check if the database name is correct in .env file");
    } else if (error.message.includes("connect ETIMEDOUT")) {
      console.error("   Please check if the database host is reachable");
    }
  }
}
testPrismaConnection();

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
app.use(express.urlencoded({ extended: true }));

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
  return res.json({ 
    ok: true, 
    service: "order-service",
    timestamp: new Date().toISOString()
  });
});

/* ===================== Root endpoint ===================== */

app.get("/", (_req, res) => {
  return res.json({
    message: "📦 Order Service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      orders: "/api/orders",
      cancelled: "/cancelled",
      delivered: "/api/delivered-orders",
      scheduled: "/api/scheduled-orders",
      notifications: "/api/order_notification",
      user_notifications: "/api/user_notification"
    }
  });
});

/* ===================== REST routes ===================== */

app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);
app.use("/api/user_notification", usernotificationRoutes);
app.use("/api", scheduledOrdersRoutes);
app.use("/cancelled", cancelledOrderRoutes);
app.use("/api/delivered-orders", deliveredOrderRoutes);

/* ===================== 404 handler ===================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
    requestedUrl: req.originalUrl
  });
});

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

// List all registered routes
const listRoutes = () => {
  const stack = app?._router?.stack || [];
  console.log("\n📋 Registered Routes:");
  console.log("-------------------");
  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .join(",");
      console.log(`${methods.padEnd(8)} ${layer.route.path}`);
    }
  }
  console.log("-------------------\n");
};

(async () => {
  try {
    await initOrderManagementTable();

    // Attach socket handlers to the same server
    await attachRealtime(server);

    /* ===================== Background services ===================== */

    // 1. Process accepted scheduled orders from scheduled_orders_accepted
    startScheduledOrderProcessor();

    // 2. Auto-cancel normal pending orders
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

    // 5. Scheduled-order cleanup
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
      console.log(`\n🚀 Order service + Realtime listening on port number :${PORT}`);
      console.log(`📍 URL: http://localhost:${PORT}`);
      console.log(`❤️  Health check: http://localhost:${PORT}/health`);
      console.log(`📦 Uploads served at: http://localhost:${PORT}/uploads/...`);
      console.log(`⏰ Started at: ${new Date().toISOString()}\n`);
    });
    
    // List routes after server starts
    setTimeout(listRoutes, 100);
    
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received, shutting down gracefully...");
  await prisma.$disconnect();
  console.log("✅ Prisma disconnected");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down gracefully...");
  await prisma.$disconnect();
  console.log("✅ Prisma disconnected");
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  console.error(error.stack);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("reason:", reason);
  process.exit(1);
});