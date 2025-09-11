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

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Create tables at server start
initMerchantTables()
  .then(() => console.log("✅ Merchant tables initialized"))
  .catch((err) => console.error("❌ Error initializing merchant tables:", err));

app.use("/uploads", express.static("uploads"));
app.use("/api/merchant", merchantRoutes);
app.use("/api/admin", businessTypesRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api", updateMerchantRoute);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at ${PORT}`);
});
