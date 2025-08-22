const express = require("express");
const initMenuTables = require("./models/initModel");
const foodMenuRoute = require("./routes/foodMenuRoute");
const foodDiscoveryRoute = require("./routes/foodDiscoveryRoute");
const foodMenuBrowseRoute = require("./routes/foodMenuBrowseRoute");

const app = express();
app.use(express.json());

// Initialize menu tables
initMenuTables();
app.use("/api/food-menu", foodMenuRoute);
app.use("/api/food", foodDiscoveryRoute);
app.use("/api/food", foodMenuBrowseRoute);

app.listen(9090,"0.0.0.0", () => {
    console.log("🚀 Server running on port 9090")
});
