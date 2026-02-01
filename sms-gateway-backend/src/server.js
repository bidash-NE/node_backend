import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { config } from "./config.js";
import { SmppManager } from "./smpp/SmppManager.js";
import { smsRouter } from "./routes/sms.routes.js";

const logger = pino({ level: "info" });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));

const smpp = new SmppManager({
  logger,
  providers: config.smpp.providers,
  defaultProvider: config.smpp.defaultProvider
});
smpp.start();

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    smpp: {
      defaultProvider: smpp.getDefaultProvider(),
      providers: smpp.isReady()
    },
    time: new Date().toISOString()
  });
});

app.use("/api/sms", smsRouter({ smpp, logger }));

app.listen(config.port, () => {
  logger.info(`SMS Gateway listening on http://localhost:${config.port}`);
});

process.on("SIGINT", () => {
  logger.info("Shutting down...");
  smpp.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  smpp.stop();
  process.exit(0);
});
