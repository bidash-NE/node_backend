// server.js
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime");

dotenv.config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// serve test pages if you want: http://localhost:1001/user.html, /merchant.html
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// REST routes
app.use("/", orderRoutes);

// single HTTP server for REST + Socket.IO
const server = http.createServer(app);

(async () => {
  try {
    await initOrderManagementTable(); // orders, order_items, order_notification (no FK to orders)
    await attachRealtime(server); // socket (dev no-auth enabled inside)
    const PORT = Number(process.env.PORT || 1001);
    server.listen(PORT, "0.0.0.0", () =>
      console.log(
        `🚀 Order service + Realtime Socket.io listening on port:${PORT}`
      )
    );
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();
