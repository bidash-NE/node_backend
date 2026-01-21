// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { initAdminLogsTable } = require("./models/initModel.js");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1); // if behind 1 proxy (common with k8s ingress)

// ───────────────────────── Middlewares ─────────────────────────
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());
app.use((req, _res, next) => {
  console.log("➡️ HIT", req.method, req.originalUrl);
  next();
});

// ───────────────────────── Routes ─────────────────────────
const adminRoutes = require("./routes/adminRoute");
const adminLogRoutes = require("./routes/adminLogsRoute");
const orderReportRoutes = require("./routes/ordersReportRoutes");
const adminCollaboratorRoutes = require("./routes/adminCollaboratorRoutes"); // 👈 NEW
const systemNotificationRoute = require("./routes/systemNotificationRoute");
const appRatingRoutes = require("./routes/appRatingRoutes");
const pointSystemRoutes = require("./routes/pointSystemRoutes");
const userPointConversionRoutes = require("./routes/userPointConversionRoutes");

// User point conversion routes

app.use("/api/admin", adminRoutes);
app.use("/api/admin-logs", adminLogRoutes);
app.use("/api/orders", orderReportRoutes);
app.use("/api/system-notifications", systemNotificationRoute);
app.use("/api/app-ratings", appRatingRoutes);
app.use("/api/admin-collaborators", adminCollaboratorRoutes); // 👈 NEW
app.use("/api/points", pointSystemRoutes);
app.use("/api/user", userPointConversionRoutes);

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// 404 for unknown API routes
app.use("/api", (_req, res) =>
  res.status(404).json({ success: false, error: "Not found" }),
);

// ───────────────────────── Startup ─────────────────────────
async function start() {
  try {
    // Creates/ensures tables: admin_logs + admin_collaborators
    await initAdminLogsTable();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port NO${PORT}`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

// Global error guards
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

start();

module.exports = app;
