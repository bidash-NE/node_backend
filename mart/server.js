const express = require("express");
const path = require("path");
const cors = require("cors");

const martMenuRoutes = require("./routes/martMenuRoutes");
const martMenuBrowseRoutes = require("./routes/martMenuBrowseRoutes");
const martDiscoveryRoutes = require("./routes/martDiscoveryRoutes");
const martRatingsRoutes = require("./routes/martRatingsRoutes");
const cartRoutes = require("./routes/cartRoute");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Load upload root from .env (default to ./uploads for local dev)
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

// ✅ Ensure consistent serving of uploaded files
app.use("/uploads", express.static(UPLOAD_ROOT));

// mount mart APIs
app.use("/api/mart-menu", martMenuRoutes);
app.use("/api/mart/browse", martMenuBrowseRoutes);
app.use("/api/mart/discovery", martDiscoveryRoutes);
app.use("/api/mart/ratings", martRatingsRoutes);
app.use("/api/mart/cart", cartRoutes);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server is running on port no ${PORT}`);
});
