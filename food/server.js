const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");

// Import Prisma
const { prisma } = require("./lib/prisma");

// Import routes
const foodMenuRoute = require("./routes/foodMenuRoute");
const foodDiscoveryRoute = require("./routes/foodDiscoveryRoute");
const foodMenuBrowseRoute = require("./routes/foodMenuBrowseRoute");
const foodRatingsRoutes = require("./routes/foodRatingsRoutes");

// Load env (MUST BE FIRST)
dotenv.config();

const app = express();

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

// CORS (allow browser apps to call you)
app.use(cors({ origin: true, credentials: true }));

// JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1); // if behind 1 proxy (common with k8s ingress)

// Load upload root from .env (default to ./uploads for local dev)
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

// Ensure consistent serving of uploaded files
app.use("/uploads", express.static(UPLOAD_ROOT));

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
      console.error(
        "   Please check your database username and password in .env file",
      );
    } else if (error.message.includes("Unknown database")) {
      console.error(
        "   Please check if the database name is correct in .env file",
      );
    } else if (error.message.includes("connect ETIMEDOUT")) {
      console.error("   Please check if the database host is reachable");
    }
  }
}
testPrismaConnection();

// Health endpoints (for ingress and checks)
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "food-service",
    timestamp: new Date().toISOString(),
  }),
);
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    service: "food-service",
    timestamp: new Date().toISOString(),
  }),
);

// Routes
app.use("/api/food-menu", foodMenuRoute);
app.use("/api/food/discovery", foodDiscoveryRoute);
app.use("/api/food", foodMenuBrowseRoute);
app.use("/api/food/ratings", foodRatingsRoutes);

// Simple root route
app.get("/", (_req, res) =>
  res.json({
    message: "🍔 Food service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      menu: "/api/food-menu",
      discovery: "/api/food/discovery",
      browse: "/api/food",
      ratings: "/api/food/ratings",
      cart: "/api/food/cart",
    },
  }),
);

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

// Call listRoutes after all routes are registered
setTimeout(listRoutes, 100);

const PORT = process.env.PORT || 3003;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Food service running on port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
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
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("reason:", reason);
  process.exit(1);
});
