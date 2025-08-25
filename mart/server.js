// server.js
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

// serve uploads (so images returned like /uploads/mart-menu/xxx.jpg work)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// mount mart APIs
app.use("/api/mart-menu", martMenuRoutes);
app.use("/api/mart/browse", martMenuBrowseRoutes);
app.use("/api/mart/discovery", martDiscoveryRoutes);
app.use("/api/mart/ratings", martRatingsRoutes);
// health
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = 9009;
app.listen(PORT, () =>
  console.log(`MART API listening on http://localhost:${PORT}`)
);
