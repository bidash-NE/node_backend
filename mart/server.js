const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");

// Import Prisma
const { prisma } = require("./lib/prisma");

// Import routes
const martMenuRoutes = require("./routes/martMenuRoutes");
const martMenuBrowseRoutes = require("./routes/martMenuBrowseRoutes");
const martDiscoveryRoutes = require("./routes/martDiscoveryRoutes");
const martRatingsRoutes = require("./routes/martRatingsRoutes");
const urlCipherRoutes = require("./routes/urlCipherRoute");

// Load env (MUST BE FIRST)
dotenv.config();

const app = express();

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

// CORS
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
    console.log("✅ Prisma connected to database successfully !");

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

// Health endpoints
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "mart-service",
    timestamp: new Date().toISOString(),
  }),
);

// Root endpoint
app.get("/", (_req, res) =>
  res.json({
    message: "🛍️ Mart service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      menu: "/api/mart-menu",
      browse: "/api/mart/browse",
      discovery: "/api/mart/discovery",
      ratings: "/api/mart/ratings",
      cart: "/api/mart/cart",
      urlCipher: "/api/url-cipher",
    },
  }),
);

// Mount mart APIs
app.use("/api/mart-menu", martMenuRoutes);
app.use("/api/mart/browse", martMenuBrowseRoutes);
app.use("/api/mart/discovery", martDiscoveryRoutes);
app.use("/api/mart/ratings", martRatingsRoutes);
app.use("/api/url-cipher", urlCipherRoutes);

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

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Mart service running on port ${PORT}`);
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
  console.error(error.stack);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("reason:", reason);
  process.exit(1);
});
