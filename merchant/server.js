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
// Multer errors -> clean JSON
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "File too large. Max allowed size exceeded.",
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Upload failed.",
    });
  }
  next();
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running at port NO: ${PORT}`),
);
