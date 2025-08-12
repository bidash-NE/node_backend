const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { initAdminLogsTable } = require("./models/initModel.js"); // ← init table

const app = express();
const PORT = process.env.PORT || 6000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
const adminLogRoutes = require("./routes/adminLogsRoute");
const adminRoutes = require("./routes/adminRoute");
app.use("/api/admin", adminRoutes);
app.use("/api/admin-logs", adminLogRoutes);
// Simple healthcheck
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Start only after DB init
async function start() {
  try {
    await initAdminLogsTable(); // ← creates if not exists
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

// Safety nets
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

start();

module.exports = app;
