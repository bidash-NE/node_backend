// src/index.js
import "dotenv/config.js"; // if this fails, change to: import "dotenv/config";
import path from "node:path"; // ⬅️ for static /uploads
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import mongoose from "mongoose";
import { startScheduledRidesWorker } from "./workers/scheduledRidesWorker.js";
import scheduledRoutes from "./routes/scheduledRides.routes.js";

import matchRoutes from "./routes/match.routes.js";
import { makeDbOfferAdapter } from "./matching/dbOfferAdapter.js";

import { mysqlPool } from "./db/mysql.js";
import { initDriverSocket } from "./sockets/driver.js";
import { driverJobsRouter } from "./routes/driverJobs.js";
import { earningsRouter } from "./routes/earnings.js";
import { ratingsRouter } from "./routes/ratings.js";
import { ridesTypesRouter } from "./routes/rideTypes.js";

// ⬇️ matching (unchanged)
import { makeMatchingRouter } from "./routes/matching.js";
import { makeOfferAdapter } from "./services/offerAdapter.js";
import { configureMatcher } from "./matching/matcher.js";
import nearbyDriversApi from "./routes/nearbyDriversApi.js";
import locationsRouter from "./routes/locations.js";
import places from "./routes/places.js";
import makeDriverLookupRouter from "./routes/driverLookup.js";
import currentRidesRouter from "./routes/currentRides.js";
import tipsRouter from "./routes/tipsRouter.js";
import userDetailsLookup from "./routes/userDetails.js";
import rideGroupRoutes from "./routes/rideGroup.routes.js";
import guestWaypointsRouter from "./routes/guestWaypoints.routes.js";

// ⬇️ chat upload/list routes
import { makeChatUploadRouter } from "../src/routes/chatUpload.js";
import { makeChatListRouter } from "../src/routes/chatList.js";
import driverDeliveryRoutes from "./routes/driverDelivery.js";
import { getDeliveryRideId } from "./routes/getDeliveryRideId.js";
import { getBatchAndRideId } from "./routes/getBatchId&RideId.js";

// tax and platform rules
import taxRulesRoutes from "./routes/taxRules.routes.js";
import platformFeeRulesRoutes from "./routes/platformFeeRules.route.js";
import pricingRoutes from "./routes/pricing.route.js";
// finance routes
import financeRoutes from "./routes/finance.routes.js";
import refundRoutes from "./routes/refund.routes.js";
import driverSettlementRoutes from "./routes/drivers.settlement.routes.js";

const app = express();

/* ============================= Middlewares ============================= */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  }),
);

app.use(express.json({ limit: "10mb" }));

// ✅ IMPORTANT: serve uploads from the same root where multer saves
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(UPLOAD_ROOT));

/* ============================== Health ================================ */
app.get("/", (_req, res) => res.json({ ok: true }));

// ✅ richer health endpoint (shows mongo readiness)
app.get("/health", (_req, res) => {
  const rs = mongoose.connection.readyState; // 0,1,2,3
  const mongoState =
    rs === 1
      ? "connected"
      : rs === 2
        ? "connecting"
        : rs === 3
          ? "disconnecting"
          : "disconnected";

  res.json({
    ok: true,
    time: new Date().toISOString(),
    mongo: { readyState: rs, state: mongoState },
  });
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
app.use("/api", userDetailsLookup(mysqlPool));
app.use("/driver/delivery", driverDeliveryRoutes);
app.use("/api/settlements", driverSettlementRoutes);
app.use("/api", rideGroupRoutes);
app.use("/api", guestWaypointsRouter(mysqlPool));

// tax and platform fee rules routes
app.use("/tax-rules", taxRulesRoutes);
app.use("/platform-fee-rules", platformFeeRulesRoutes);
app.use("/pricing", pricingRoutes);

// finance routes
app.use("/finance", financeRoutes);
app.use("/finance", refundRoutes);

app.use("/api/batch-ride", getBatchAndRideId());

// chat upload route
app.use("/chat", makeChatUploadRouter("/uploads"));

/* ========================= HTTP + Socket.IO =========================== */
const server = http.createServer(app);

// ✅ Smooth + stable Socket.IO config for mobile networks
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },

  // ✅ IMPORTANT: do not force websocket only; allow fallback
  transports: ["websocket", "polling"],

  // ✅ prevent "ping timeout" when server is busy (Node event-loop stalls)
  pingInterval: 25000,
  pingTimeout: 60000,

  // ✅ reduce CPU & latency spikes (especially on high-frequency events)
  perMessageDeflate: false,

  // ✅ if you send images/chat payloads through socket, avoid buffer errors
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB
});

// Optional: hydrate socket identity from handshake
// This won't override existing values.
io.use((socket, next) => {
  const a = socket.handshake.auth || socket.handshake.query || {};

  try {
    if (
      !socket.data.role &&
      (a.role === "driver" || a.role === "passenger" || a.role === "merchant")
    ) {
      socket.data.role = a.role;
    }
    if (socket.data.driver_id == null && a.driver_id != null) {
      socket.data.driver_id = String(a.driver_id);
    }
    if (socket.data.passenger_id == null && a.passenger_id != null) {
      socket.data.passenger_id = String(a.passenger_id);
    }
    if (socket.data.merchant_id == null && a.merchant_id != null) {
      socket.data.merchant_id = String(a.merchant_id);
    }
  } catch {}

  next();
});

// matcher setup (unchanged)
const adapter = {
  ...makeOfferAdapter(mysqlPool), // your existing logic (if any)
  ...makeDbOfferAdapter({ mysqlPool }), // adds DB offer-state writes
};
configureMatcher(adapter);

// Attach sockets
initDriverSocket(io, mysqlPool);

// Mount routers that need `io` AFTER io is created
app.use("/rides/match", makeMatchingRouter(io, mysqlPool));
app.use("/rides", currentRidesRouter(mysqlPool));
app.use("/api", makeChatListRouter(mysqlPool));
app.use("/api/delivery", getDeliveryRideId);
app.use("/api/scheduled-rides", scheduledRoutes);

/* ============================ Mongo events ============================ */
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB connection error:", err),
);
mongoose.connection.on("disconnected", () =>
  console.warn("⚠ MongoDB disconnected"),
);

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
    // ✅ connect Mongo first so any mongo usage won't buffer/time out
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) {
      console.warn("⚠ MONGO_URI not set — Mongo features may fail");
    } else {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
      });
    }

    // ✅ Then check MySQL
    await testMySQLConnection();

    // ✅ Start HTTP server
    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`HTTP+WS listening on http://localhost:${PORT}`);
    });

    // ✅ Start workers AFTER DB connections are ready
    startScheduledRidesWorker({ io, mysqlPool, pollMs: 20000, batchSize: 25 });

    // Optional: graceful shutdown
    const shutdown = async (sig) => {
      console.log(`\n${sig} received — shutting down.....`);
      try {
        await mongoose.disconnect();
      } catch {}
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
