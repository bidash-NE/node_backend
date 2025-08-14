const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const { initAdminLogsTable } = require("./models/initModel.js"); // Initialize DB table

const app = express();

// Use port from env or fallback to 6000
const PORT = process.env.PORT || 6060;

// Enable CORS for all origins (you can restrict origins here if needed)
app.use(
  cors({
    origin: "*", // Allow all origins; for production specify allowed domains
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse incoming JSON requests
app.use(express.json());

// Routes
const adminLogRoutes = require("./routes/adminLogsRoute");
const adminRoutes = require("./routes/adminRoute");
app.use("/api/admin", adminRoutes);
app.use("/api/admin-logs", adminLogRoutes);

// Simple healthcheck endpoint
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Start server only after DB initialization
async function start() {
  try {
    await initAdminLogsTable();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running and accessible at http://0.0.0.0:${PORT}`);
      console.log(`🌐 Use your server IP or localhost:${PORT} to access it`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// Start the app
start();

module.exports = app;
