const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const rideTypeRoutes = require("./routes/rideTypeRoute");
const riderRequestRoutes = require("./routes/riderRequestRoute");
const popularLocationRoute = require("./routes/popularLocationRoute");
const rideAcceptedRoute = require("./routes/rideAcceptedRoute");
const notificationRoutes = require("./routes/notificationRoute");
const initRideTables = require("./models/initModel");
const connectMongo = require("./config/mongo");
const warmupRideTypesIfNeeded = require("./scripts/warmupRideTypes");

const redis = require("./config/redis");
const db = require("./config/db");

const app = express();
const PORT = process.env.PORT || 7000;

// ✅ CORS setup: Allow all origins (any device, any IP)
const corsOptions = {
  origin: "*", // Allow all origins
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: false, // Set to true only if you are using cookies or auth headers
};

app.use(cors(corsOptions));
app.use(express.json());

// ✅ Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ✅ API routes
app.use("/api", popularLocationRoute);
app.use("/api/ridetypes", rideTypeRoutes);
app.use("/api/rides", riderRequestRoutes);
app.use("/api/riderequest", rideAcceptedRoute);
app.use("/api/notifications", notificationRoutes);

// ✅ Create HTTP + Socket.IO server
const server = http.createServer(app);

// ✅ Socket.IO setup with open CORS policy
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"],
    credentials: false,
  },
});

// Make io accessible in your controllers
app.locals.io = io;

// ✅ Load your socket handlers
require("./socket")(io);

// ✅ Main Startup Function
async function startServer() {
  try {
    await connectMongo(); // Connect to MongoDB
    await initRideTables(); // Setup MySQL tables if not exist
    await warmupRideTypesIfNeeded(); // Warm up ride types if needed

    // ✅ Bind to 0.0.0.0 so it's accessible from other devices on LAN/WAN
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server API running at: http://localhost:${PORT}`);
      console.log(`📡 Socket.IO server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
