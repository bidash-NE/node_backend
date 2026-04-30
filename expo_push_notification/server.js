// server.js - CORRECT ORDER
const dotenv = require("dotenv");
dotenv.config(); // ✅ MUST BE FIRST!

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const express = require("express");
const cors = require("cors");
const path = require("path");

const { prisma } = require("./lib/prisma.js");
const pushRoutes = require("./routes/pushRoutes");

const app = express();

// CORS setup
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

// Test Prisma connection
async function testPrismaConnection() {
  try {
    await prisma.$connect();
    console.log("✅ Prisma connected to database successfully!");

    // Fixed: Simple query without alias that might cause issues
    const result = await prisma.$queryRaw`SELECT 1 as connected`;
    console.log("✅ Database connection verified");
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);
    if (error.message.includes("Access denied")) {
      console.error(
        "   Please check your database username and password in .env file",
      );
    } else if (error.message.includes("Unknown database")) {
      console.error(
        "   Please check if the database name is correct in .env file",
      );
    } else if (error.message.includes("connect ETIMEDOUT")) {
      console.error("   Please check if the database host is reachable");
    } else {
      console.error("   Please check your database configuration in .env file");
    }
  }
}
testPrismaConnection();

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "expo-push-notification",
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "📱 Expo Push Notification Service",
    status: "running",
    endpoints: {
      health: "GET /health",
      sendPush: "POST /api/push/send",
      registerToken: "POST /api/push/register-token",
      getTokens: "GET /api/push/tokens/:user_id",
    },
  });
});

// Register routes
app.use("/api/push", pushRoutes);

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
    requestedUrl: req.originalUrl,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error. Please try again later.",
  });
});

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
      console.log(`${methods.padEnd(8)} /api/push${layer.route.path}`);
    }
  }
  console.log("-------------------\n");
};

// Call listRoutes after all routes are registered
setTimeout(listRoutes, 100);

const PORT = Number(process.env.PORT || 3007);
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Expo Push Notification Service is running!`);
  console.log(
    `📍 URL: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
  );
  console.log(`❤️  Health check : http://localhost:${PORT}/health`);
  console.log(`📱 Push API base: http://localhost:${PORT}/api/push`);
  console.log(`⏰ Started at: ${new Date().toISOString()}\n`);
});

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
