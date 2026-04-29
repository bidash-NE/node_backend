// server.js - CORRECT ORDER
const dotenv = require("dotenv");
dotenv.config(); // ✅ MUST BE FIRST!

const express = require("express");
const path = require("path");
const cors = require("cors");

const { prisma } = require("./lib/prisma.js");
// const connectMongo = require("./config/mongo");
const { checkAndCreateTables } = require("./models/initModel");

const registrationRoutes = require("./routes/registrationRoute");
const authRoutes = require("./routes/authRoute");
const deviceRoutes = require("./routes/deviceRoute");
const forgotPasswordRoute = require("./routes/forgotPasswordRoute");
const profileRoutes = require("./routes/profileRoute");
const smsOtpRoutes = require("./routes/smsOtpRoutes");

const app = express();

// CORS setup
app.use(cors());
app.use(express.json());
app.set("trust proxy", 1);

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");
app.use("/uploads", express.static(UPLOAD_ROOT));

// Connect to MongoDB and check/create MySQL tables
// connectMongo();
checkAndCreateTables();

// Replace the testPrismaConnection function with this:
async function testPrismaConnection() {
  try {
    await prisma.$connect();
    console.log("✅ Prisma connected to database successfully!");
    // Remove the $queryRaw test - it's not needed
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);
  }
}
testPrismaConnection();

// Register your routes
app.use("/api/auth", authRoutes);
app.use("/api/sms-otp", smsOtpRoutes);
app.use("/api", registrationRoutes);
app.use("/api", deviceRoutes);
app.use("/api/forgotpassword", forgotPasswordRoute);
app.use("/api/profile", profileRoutes);

const listRoutes = () => {
  const stack = app?._router?.stack || [];
  console.log("---- ROUTES ----");
  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .join(",");
      console.log(`${methods} ${layer.route.path}`);
    }
  }
  console.log("---------------");
};

listRoutes();

app.get("/", (req, res) => {
  res.send("🚗 Ride App Backend Running");
});

const PORT = process.env.PORT || 3000;
app.get("/health", (_req, res) => res.json({ ok: true }));
// Call it without waiting for query test
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at port no ${PORT}`),
);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received, closing Prisma connection...");
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing Prisma connection...");
  await prisma.$disconnect();
  process.exit(0);
});
