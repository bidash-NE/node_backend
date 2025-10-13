// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { initAdminLogsTable } = require("./models/initModel.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ───────────────────────── Middlewares ─────────────────────────
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// ───────────────────────── Routes ─────────────────────────
const adminRoutes = require("./routes/adminRoute");
const adminLogRoutes = require("./routes/adminLogsRoute");
const orderReportRoutes = require("./routes/ordersReportRoutes");
const adminCollaboratorRoutes = require("./routes/adminCollaboratorRoutes"); // 👈 NEW

app.use("/api/admin", adminRoutes);
app.use("/api/admin-logs", adminLogRoutes);
app.use("/api/orders", orderReportRoutes);

// Mount collaborators at /api/admin-collaborators
// (routes file should expose relative paths: '/', '/:id', etc.)
app.use("/api/admin-collaborators", adminCollaboratorRoutes); // 👈 NEW

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// 404 for unknown API routes
app.use("/api", (_req, res) =>
  res.status(404).json({ success: false, error: "Not found" })
);

// ───────────────────────── Startup ─────────────────────────
async function start() {
  try {
    // Creates/ensures tables: admin_logs + admin_collaborators
    await initAdminLogsTable();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port ${PORT}`);
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
