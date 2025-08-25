const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const initMenuTables = require("./models/initModel");
const foodMenuRoute = require("./routes/foodMenuRoute");
const foodDiscoveryRoute = require("./routes/foodDiscoveryRoute");
const foodMenuBrowseRoute = require("./routes/foodMenuBrowseRoute");
const foodRatingsRoutes = require("./routes/foodRatingsRoutes");
const app = express();
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Initialize menu tables
initMenuTables();

app.use("/api/food-menu", foodMenuRoute);
app.use("/api/food/discovery", foodDiscoveryRoute);
app.use("/api/food", foodMenuBrowseRoute);
app.use("/api/food/ratings", foodRatingsRoutes);
app.listen(9090, "0.0.0.0", () => {
  console.log("🚀 Server running on port 9090");
});
