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

const PORT = process.env.PORT || 3000;
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running at ${PORT}`));
