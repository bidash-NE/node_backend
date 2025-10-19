// server.js
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();

const db = require("./config/db"); // <-- promise pool
const { initWalletTables } = require("./models/init");
const walletRoutes = require("./routes/walletRoutes");

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

(async () => {
  try {
    // 1) Make sure DB tables exist
    await initWalletTables();

    // 2) Set pool session timezone to +06:00 (Bhutan)
    await db.configureSessionTimezone();

    // 3) Routes
    app.use("/wallet", walletRoutes);
    app.get("/wallet-payment/health", (_req, res) => {
      res.json({ ok: true, now: new Date().toISOString() });
    });
    // optional: leave /health too if you want
    app.get("/health", (_req, res) => {
      res.json({ ok: true, now: new Date().toISOString() });
    });

    app.get("/health", async (_, res) => {
      const [r] = await db.query("SELECT NOW() AS now");
      res.json({ ok: true, now: r[0].now });
    });

    const PORT = process.env.PORT || 1111;
    app.listen(PORT, () =>
      console.log(`💰 wallet_payment listening on :${PORT}`)
    );
  } catch (err) {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  }
})();
