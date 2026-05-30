// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { prisma } = require("./lib/prisma.js");
const { UPLOAD_ROOT } = require("./middleware/upload");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // if behind proxy (k8s / nginx)

// ───────────────────────── Middlewares ─────────────────────────

// ✅ Proper CORS Configuration
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// Body parser
app.use(express.json());

// Debug logger
app.use((req, _res, next) => {
  console.log("➡️ HIT", req.method, req.originalUrl);
  next();
});

// ───────────────────────── Static Uploads ─────────────────────────

// ✅ IMPORTANT:
// This uses the same UPLOAD_ROOT from middleware/upload.js
// If middleware/upload.js uses admin/uploads,
// then this also serves admin/uploads.
console.log("📂 Serving admin uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Routes ─────────────────────────

const adminRoutes = require("./routes/adminRoute");
const adminLogRoutes = require("./routes/adminLogsRoute");
const orderReportRoutes = require("./routes/ordersReportRoutes");
const adminCollaboratorRoutes = require("./routes/adminCollaboratorRoutes");
const systemNotificationRoute = require("./routes/systemNotificationRoute");
const appRatingRoutes = require("./routes/appRatingRoutes");
const pointSystemRoutes = require("./routes/pointSystemRoutes");
const userPointConversionRoutes = require("./routes/userPointConversionRoutes");
const contactRoutes = require("./routes/contactMessageRoutes");
const logoImageRoutes = require("./routes/logoImageRoutes");

// Routes
app.use("/api/admin", adminRoutes);
app.use("/api/admin-logs", adminLogRoutes);
app.use("/api/orders", orderReportRoutes);
app.use("/api/system-notifications", systemNotificationRoute);
app.use("/api/app-ratings", appRatingRoutes);
app.use("/api/admin-collaborators", adminCollaboratorRoutes);
app.use("/api/points", pointSystemRoutes);
app.use("/api/user", userPointConversionRoutes);
app.use("/api/contact-messages", contactRoutes);
app.use("/api/logo-images", logoImageRoutes);

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 404 handler for API routes
app.use("/api", (_req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
  });
});

// ───────────────────────── Startup ─────────────────────────

async function start() {
  try {
    // Test Prisma connection on startup
    await prisma.$connect();
    console.log("✅ Prisma connected to database");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  }
}

// Graceful shutdown - disconnect Prisma
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing server...");
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing server...");
  await prisma.$disconnect();
  process.exit(0);
});

// Global error handlers
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

start();

module.exports = app;