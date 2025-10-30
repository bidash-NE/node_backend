// server.js
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { initOrderManagementTable } = require("./models/initModel");
const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime"); // <- socket attach
const notificationRoutes = require("./routes/notificationRoutes");
dotenv.config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// serve simple test pages (optional)
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// REST routes
app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);

// single HTTP server for REST + Socket.IO
const server = http.createServer(app);

(async () => {
  try {
    await initOrderManagementTable(); // create tables if missing
    await attachRealtime(server); // bind socket.io to this server
    const PORT = Number(process.env.PORT || 1001);
    server.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 Order service + Realtime listening on :${PORT}`)
    );
  } catch (err) {
    console.error("Boot failed:", err);
    process.exit(1);
  }
})();
