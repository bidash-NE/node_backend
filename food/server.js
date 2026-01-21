const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");

// const initMenuTables = require("./models/initModel");
const foodMenuRoute = require("./routes/foodMenuRoute");
const foodDiscoveryRoute = require("./routes/foodDiscoveryRoute");
const foodMenuBrowseRoute = require("./routes/foodMenuBrowseRoute");
const foodRatingsRoutes = require("./routes/foodRatingsRoutes");
const cartRoutes = require("./routes/cartRoute");

// Load env
dotenv.config();

const app = express();

// CORS (allow browser apps to call you)
app.use(cors({ origin: true, credentials: true }));

// JSON parsing
app.use(express.json());
app.set("trust proxy", 1); // if behind 1 proxy (common with k8s ingress)

// ✅ Load upload root from .env (default to ./uploads for local dev)
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

// ✅ Ensure consistent serving of uploaded files
app.use("/uploads", express.static(UPLOAD_ROOT));

// Init DB tables
// initMenuTables();

// Health endpoints (for ingress and checks)
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Routes
app.use("/api/food-menu", foodMenuRoute);
app.use("/api/food/discovery", foodDiscoveryRoute);
app.use("/api/food", foodMenuBrowseRoute);
app.use("/api/food/ratings", foodRatingsRoutes);
app.use("/api/food/cart", cartRoutes);

// Simple root route
app.get("/", (_req, res) => res.send("🍔 Food service up"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port  ${PORT}`);
});
