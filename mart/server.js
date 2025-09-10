const express = require("express");
const path = require("path");
const cors = require("cors");

const martMenuRoutes = require("./routes/martMenuRoutes");
const martMenuBrowseRoutes = require("./routes/martMenuBrowseRoutes");
const martDiscoveryRoutes = require("./routes/martDiscoveryRoutes");
const martRatingsRoutes = require("./routes/martRatingsRoutes");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve uploaded images
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// mount mart APIs
app.use("/api/mart-menu", martMenuRoutes);
app.use("/api/mart/browse", martMenuBrowseRoutes);
app.use("/api/mart/discovery", martDiscoveryRoutes);
app.use("/api/mart/ratings", martRatingsRoutes);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
