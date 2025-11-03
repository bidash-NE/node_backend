// src/index.js
import "dotenv/config.js";               // if this fails, change to: import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import mongoose from "mongoose";

import { mysqlPool } from "./db/mysql.js";
import { initDriverSocket } from "./sockets/driver.js";
import { driverJobsRouter } from "./routes/driverJobs.js";
import { earningsRouter } from "./routes/earnings.js";
import { ratingsRouter } from "./routes/ratings.js";
import { ridesTypesRouter } from "./routes/rideTypes.js";

// ⬇️ NEW: sequential matching route (uses Redis presence/matcher modules we added)
import { makeMatchingRouter } from "./routes/matching.js";
import { makeOfferAdapter } from "./services/offerAdapter.js";
import { configureMatcher } from "./matching/matcher.js";
import nearbyDriversApi from "./routes/nearbyDriversApi.js";
import locationsRouter from "./routes/locations.js"
import places from "./routes/places.js";
import makeDriverLookupRouter from "./routes/driverLookup.js";
import currentRidesRouter from "./routes/currentRides.js";
import tipsRouter from "./routes/tipsRouter.js";

const app = express();

/* ============================= Middlewares ============================= */
app.use(cors());
app.use(express.json());

/* ============================== Health ================================ */
app.get("/", (_req, res) => res.json({ ok: true }));

/* =============================== Routes =============================== */
// Existing routes (unchanged)
app.use("/api/driver/jobs", driverJobsRouter(mysqlPool));
app.use("/api/driver", earningsRouter(mysqlPool));
app.use("/api", ratingsRouter(mysqlPool));
app.use("/api", nearbyDriversApi(mysqlPool));  // <-- NEW: nearby drivers API
app.use("/api", ridesTypesRouter);
app.use('/api/rides/locations', locationsRouter);
app.use("/api/places", places);
app.use("/api", makeDriverLookupRouter(mysqlPool));
app.use("/api/tips",tipsRouter(mysqlPool));


/* ========================= HTTP + Socket.IO =========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const adapter = makeOfferAdapter(mysqlPool);
configureMatcher(adapter);

// Attach sockets
initDriverSocket(io, mysqlPool);

// ⬇️ NEW: mount matching router AFTER io is created so it can use it
app.use("/rides/match", makeMatchingRouter(io,mysqlPool));
app.use("/rides", currentRidesRouter);

/* ============================ Mongo events ============================ */
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", (err) => console.error("❌ MongoDB connection error:", err));
mongoose.connection.on("disconnected", () => console.warn("⚠ MongoDB disconnected"));

/* ============================ MySQL check ============================= */
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
    await mongoose.connect(process.env.MONGO_URI, {
      // For Mongoose v7+, these options are not required; harmless if left.
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await testMySQLConnection();

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`HTTP+WS listening on http://localhost:${PORT}`);
    });

    // Optional: graceful shutdown
    const shutdown = async (sig) => {
      console.log(`\n${sig} received — shutting down...`);
      try { await mongoose.disconnect(); } catch {}
      try { server.close(); } catch {}
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
