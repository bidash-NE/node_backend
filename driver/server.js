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

dotenv.config();
const app = express();

// ✅ CORS setup to allow access from any origin (any IP, domain, or port)
app.use(cors()); // <-- Allow all origins

// Middleware to parse JSON
app.use(express.json());

// Serve static files like images and documents
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Connect to MongoDB and check/create MySQL tables
connectMongo();
checkAndCreateTables();

// Register your routes
app.use("/api/auth", authRoutes);
app.use("/api", registrationRoutes);
app.use("/api", deviceRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/forgotpassword", forgotPasswordRoute);
app.use("/api/profile", profileRoutes);

// Default test route
app.get("/", (req, res) => {
  res.send("🚗 Ride App Backend Running");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
