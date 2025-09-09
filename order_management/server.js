const express = require("express");
const dotenv = require("dotenv");
const { initOrderManagementTable } = require("./models/initModel");
const db = require("./config/db");
const orderRoutes = require("./routes/orderRoutes");

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

// Initialize the order_management table
initOrderManagementTable().catch((err) => {
  console.error("Error initializing order_management table:", err);
  process.exit(1);
});

// Example route
app.get("/", (req, res) => {
  res.send("Order Management API is running!");
});

app.use("/", orderRoutes);

const PORT = process.env.PORT || 1001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
