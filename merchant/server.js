// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { initMerchantTables } = require("./models/initModel");
const merchantRoutes = require("./routes/merchantRegistrationRoute");
const businessTypesRoutes = require("./routes/businessTypesRoute");
const categoryRoutes = require("./routes/categoryRoute");
const bannerRoutes = require("./routes/bannerRoutes");
const updateMerchantRoute = require("./routes/updateMerchantRoute");
const merchantRatings = require("./routes/merchantRatings");
const salesRoutes = require("./routes/salesRoutes");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// Create tables at server start
initMerchantTables()
  .then(() => console.log("✅ Merchant tables initialized"))
  .catch((err) => console.error("❌ Error initializing merchant tables:", err));

// ✅ Load upload root from .env (default to ./uploads for local dev)
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

// ✅ Ensure consistent serving of uploaded files
app.use("/uploads", express.static(UPLOAD_ROOT));
app.use("/api/merchant", merchantRoutes);
app.use("/api/admin", businessTypesRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api", updateMerchantRoute);
app.use("/api/merchant", merchantRatings);
app.use("/api/sales", salesRoutes);

// near the other routes:
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at port NO: ${PORT}`),
);
