// src/server.js
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { config } from "./config.js";
import { SmppManager } from "./smpp/SmppManager.js";
import { smsRouter } from "./routes/sms.routes.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));

/**
 * SMPP manager
 * NOTE: Actual bind/connect happens inside SmppManager.
 */
const smpp = new SmppManager({
  logger,
  providers: config.smpp.providers,
  defaultProvider: config.smpp.defaultProvider,
});

/**
 * Helpful startup logs (no secrets).
 * Confirms which provider keys exist + default provider in use.
 */
logger.info(
  {
    port: config.port,
    env: process.env.NODE_ENV || "production",
    smpp: {
      defaultProvider: config.smpp.defaultProvider,
      providers: Object.keys(config.smpp.providers || {}),
    },
  },
  "SMS Gateway starting",
);

smpp.start();

/**
 * Health endpoint
 * - ok: service up
 * - smpp.defaultProvider: which provider is selected as default
 * - smpp.providers: readiness/status from isReady()
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    smpp: {
      defaultProvider: smpp.getDefaultProvider(),
      providers: smpp.isReady(),
    },
    time: new Date().toISOString(),
  });
});

/**
 * SMS API
 */
app.use("/api/sms", smsRouter({ smpp, logger }));

/**
 * Start server
 */
const server = app.listen(config.port, () => {
  logger.info(`SMS Gateway listening on http://localhost:${config.port}`);
});

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  try {
    logger.info({ signal }, "Shutting down...");
    server.close(() => {
      logger.info("HTTP server closed");
    });

    // stop SMPP connections
    try {
      await Promise.resolve(smpp.stop());
      logger.info("SMPP stopped");
    } catch (e) {
      logger.error({ err: e }, "Error stopping SMPP");
    }

    // small delay to flush logs
    setTimeout(() => process.exit(0), 300);
  } catch (e) {
    logger.error({ err: e }, "Shutdown error");
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Optional: log unhandled errors to avoid silent crashes
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  // Exit to avoid unknown state
  process.exit(1);
});
