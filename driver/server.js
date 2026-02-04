const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");

const connectMongo = require("./config/mongo");
const { checkAndCreateTables } = require("./models/initModel");

const registrationRoutes = require("./routes/registrationRoute");
const authRoutes = require("./routes/authRoute");
const deviceRoutes = require("./routes/deviceRoute");
const driverRoutes = require("./routes/driverRoute");
const forgotPasswordRoute = require("./routes/forgotPasswordRoute");
const profileRoutes = require("./routes/profileRoute");
const smsOtpRoutes = require("./routes/smsOtpRoutes");

dotenv.config();
const app = express();

// ✅ CORS setup to allow access from any origin (any IP, domain, or port)
app.use(cors()); // <-- Allow all origins

// Middleware to parse JSON
app.use(express.json());
app.set("trust proxy", 1); // if behind 1 proxy (common with k8s ingress)

// ✅ Load upload root from .env (default to ./uploads for local dev)
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

// ✅ Ensure consistent serving of uploaded files
app.use("/uploads", express.static(UPLOAD_ROOT));

// Connect to MongoDB and check/create MySQL tables
connectMongo();
checkAndCreateTables();

// Register your routes
app.use("/api/auth", authRoutes);
app.use("/api/sms-otp", smsOtpRoutes);
app.use("/api", registrationRoutes);
app.use("/api", deviceRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/forgotpassword", forgotPasswordRoute);
app.use("/api/profile", profileRoutes);

const listRoutes = () => {
  const stack = app?._router?.stack || [];
  console.log("---- ROUTES ----");
  for (const layer of stack) {
    // Direct routes
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .join(",");
      console.log(`${methods} ${layer.route.path}`);
    }
    // Mounted routers
    else if (layer.name === "router" && layer.regexp) {
      console.log("MOUNTED ROUTER:", layer.regexp);
    }
  }
  console.log("---------------");
};

listRoutes();

// Default test route
app.get("/", (req, res) => {
  res.send("🚗 Ride App Backend Running");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at port ${PORT}`),
);
