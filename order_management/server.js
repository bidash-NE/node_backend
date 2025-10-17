// server.js
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const orderRoutes = require("./routes/orderRoutes");

dotenv.config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// serve test pages if you want: http://localhost:1001/user.html, /merchant.html
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// REST routes
app.use("/", orderRoutes);

// Boot
(async () => {
  try {
    await initOrderManagementTable(); // orders, order_items, order_notification (no FK to orders)
    const PORT = Number(process.env.PORT || 1001);
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 Order service listening on port:${PORT}`)
    );
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();
