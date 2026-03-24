// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { initAdminLogsTable } = require("./models/initModel.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // if behind proxy (k8s / nginx)

// ───────────────────────── Middlewares ─────────────────────────

// ✅ Proper CORS Configuration
const corsOptions = {
  origin: "*", // 🔥 change to frontend domain in production
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], // ✅ PATCH added
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// Apply CORS
app.use(cors(corsOptions));

// ✅ Handle preflight explicitly (VERY IMPORTANT)
app.options("*", cors(corsOptions));

// Body parser
app.use(express.json());

// Debug logger
app.use((req, _res, next) => {
  console.log("➡️ HIT", req.method, req.originalUrl);
  next();
});

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

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// 404 handler
app.use("/api", (_req, res) =>
  res.status(404).json({ success: false, error: "Not found" }),
);

// ───────────────────────── Startup ─────────────────────────
async function start() {
  try {
    await initAdminLogsTable();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

// Global error handlers
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

start();

module.exports = app;
