// File: server.js
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");

const { prisma } = require("./lib/prisma");

const walletRoutes = require("./routes/walletRoutes");
const txRoutes = require("./routes/transactionHistoryRoutes");
const idRoutes = require("./routes/idRoutes");
const platformFeeRuleRoutes = require("./routes/platformFeeRuleRoutes");

const app = express();

/* ─────────────────── Middleware ─────────────────── */

app.use(helmet());

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

/* ─────────────────── Routes ─────────────────── */

app.use("/wallet", walletRoutes);
app.use("/transactions", txRoutes);
app.use("/ids", idRoutes);
app.use("/api/platform-fee-rules", platformFeeRuleRoutes);

/* ─────────────────── Health endpoints ─────────────────── */

app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "wallet_payment",
  });
});

app.get("/wallet/health", async (_req, res) => {
  try {
    await prisma.$connect();

    return res.json({
      ok: true,
      service: "wallet_payment",
      prisma: "connected",
      now: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      service: "wallet_payment",
      prisma: "disconnected",
      error: e?.message || "Prisma connection failed",
    });
  }
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$connect();

    return res.json({
      ok: true,
      service: "wallet_payment",
      prisma: "connected",
      now: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      service: "wallet_payment",
      prisma: "disconnected",
      error: e?.message || "Prisma connection failed",
    });
  }
});

/* ─────────────────── 404 handler ─────────────────── */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found.",
    path: req.originalUrl,
  });
});

/* ─────────────────── Global error handler ─────────────────── */

app.use((err, _req, res, _next) => {
  console.error("[SERVER ERROR]", {
    message: err?.message,
    stack: err?.stack,
  });

  return res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Internal server error.",
  });
});

/* ─────────────────── Prisma connection check ─────────────────── */

async function checkPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("[prisma] connected successfully");

    return true;
  } catch (e) {
    console.error("[prisma] connection failed", {
      message: e?.message,
      code: e?.code,
    });

    return false;
  }
}

/* ─────────────────── Graceful shutdown ─────────────────── */

let server = null;

async function shutdown(signal) {
  console.log(`[server] received ${signal}. Shutting down...`);

  try {
    if (server) {
      server.close(() => {
        console.log("[server] HTTP server closed");
      });
    }
  } catch (e) {
    console.error("[server] close error", e?.message || e);
  }

  try {
    await prisma.$disconnect();
    console.log("[prisma] disconnected");
  } catch (e) {
    console.error("[prisma] disconnect error", e?.message || e);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* ─────────────────── Listen ─────────────────── */

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const prismaOk = await checkPrismaConnection();

  if (!prismaOk) {
    console.error("[server] Startup aborted because Prisma could not connect.");
    process.exit(1);
  }

  server = app.listen(PORT, () => {
    console.log(`💰 wallet_payment listening on :${PORT}`);
  });
}

startServer().catch((e) => {
  console.error("[server] fatal startup error", {
    message: e?.message,
    code: e?.code,
    stack: e?.stack,
  });

  process.exit(1);
});

module.exports = app;