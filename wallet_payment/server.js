// server.js
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();

const db = require("./config/db"); // Promise pool connection
const { initWalletTables } = require("./models/init");
const walletRoutes = require("./routes/walletRoutes");
const txRoutes = require("./routes/transactionHistoryRoutes");
const idRoutes = require("./routes/idRoutes");
const platformFeeRuleRoutes = require("./routes/platformFeeRuleRoutes");
const app = express();

/* ─────────────────── Middleware ─────────────────── */
app.use(helmet()); // Security headers
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// make sure preflight always succeeds
app.options(/.*/, cors());
app.use(express.json());
app.use(morgan("dev"));
app.set("trust proxy", 1);

/* ─────────────────── Startup Async Init ─────────────────── */
(async () => {
  try {
    // 1) Ensure tables exist
    await initWalletTables();

    // 2) Set timezone (Bhutan +06:00)
    await db.configureSessionTimezone();

    // 3) Main routes
    app.use("/wallet", walletRoutes);
    app.use("/transactions", txRoutes);
    app.use("/ids", idRoutes);
    app.use("/api/platform-fee-rules", platformFeeRuleRoutes);

    // 4) Health endpoints
    app.get("/wallet/health", (_req, res) => {
      res.json({
        ok: true,
        service: "wallet_payment",
        now: new Date().toISOString(),
      });
    });

    app.get("/health", async (_req, res) => {
      try {
        const [rows] = await db.query("SELECT NOW() AS now");
        res.json({
          ok: true,
          service: "wallet_payment",
          now: rows[0]?.now || new Date().toISOString(),
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // 5) Start server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () =>
      console.log(`💰 wallet_payment listening on :${PORT}`),
    );
  } catch (err) {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  }
})();
