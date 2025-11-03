// src/index.js
import "dotenv/config.js";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

import { mysqlPool } from "./db/mysql.js";
import { initDriverSocket } from "./sockets/driver.js";
import { driverJobsRouter } from "./routes/driverJobs.js";
import { earningsRouter } from "./routes/earnings.js";
import { ratingsRouter } from "./routes/ratings.js";
import { ridesTypesRouter } from "./routes/rideTypes.js";

import { makeMatchingRouter } from "./routes/matching.js";
import { makeOfferAdapter } from "./services/offerAdapter.js";
import { configureMatcher } from "./matching/matcher.js";
import nearbyDriversApi from "./routes/nearbyDriversApi.js";
import locationsRouter from "./routes/locations.js";
import places from "./routes/places.js";
import makeDriverLookupRouter from "./routes/driverLookup.js";
import currentRidesRouter from "./routes/currentRides.js";
import tipsRouter from "./routes/tipsRouter.js";

const app = express();

/* ============================= Middlewares ============================= */
app.use(cors());
app.use(express.json());

/* ============================== Health ================================ */
// Basic health checks (for both internal and ingress access)
app.get(["/", "/grablike", "/grablike/"], (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "grablike-backend",
    timestamp: new Date().toISOString(),
  });
});

// Extended MySQL + uptime health check
app.get(["/health", "/grablike/health"], async (_req, res) => {
  try {
    const conn = await mysqlPool.getConnection();
    await conn.ping();
    conn.release();

    res.status(200).json({
      ok: true,
      service: "grablike-backend",
      mysql: "connected",
      uptime_sec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      service: "grablike-backend",
      mysql: "disconnected",
      error: err.message || String(err),
    });
  }
});

/* =============================== Routes =============================== */
app.use("/api/driver/jobs", driverJobsRouter(mysqlPool));
app.use("/api/driver", earningsRouter(mysqlPool));
app.use("/api", ratingsRouter(mysqlPool));
app.use("/api", nearbyDriversApi(mysqlPool));
app.use("/api", ridesTypesRouter);
app.use("/api/rides/locations", locationsRouter);
app.use("/api/places", places);
app.use("/api", makeDriverLookupRouter(mysqlPool));
app.use("/api/tips", tipsRouter(mysqlPool));

/* ========================= HTTP + Socket.IO =========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const adapter = makeOfferAdapter(mysqlPool);
configureMatcher(adapter);

// Attach sockets
initDriverSocket(io, mysqlPool);

// Mount routes that depend on IO
app.use("/rides/match", makeMatchingRouter(io, mysqlPool));
app.use("/rides", currentRidesRouter);

/* ============================ MySQL Check ============================= */
async function testMySQLConnection() {
  try {
    const conn = await mysqlPool.getConnection();
    await conn.ping();
    console.log("✅ MySQL connected");
    conn.release();
  } catch (err) {
    console.error("❌ MySQL connection failed:", err);
    process.exit(1);
  }
}

/* ============================== Startup =============================== */
async function startServer() {
  try {
    await testMySQLConnection();

    const PORT = Number(process.env.PORT || 3000);
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Grablike Backend running on http://0.0.0.0:${PORT}`);
      console.log(`🩺 Health check available at: /health and /grablike/health`);
    });

    // Graceful shutdown
    const shutdown = async (sig) => {
      console.log(`\n${sig} received — shutting down...`);
      try {
        server.close();
      } catch {}
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

startServer();
