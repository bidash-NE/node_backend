const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const paymentRoutes = require("./routes/paymentRoutes");
const rmaLogRoutes = require("./routes/rmaLogRoutes");
const withdrawalsRoutes = require("./routes/withdrawals.routes.js");
const debugRoutes = require("./routes/debugRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({ ok: true, message: "BFS wallet backend up" });
});

app.use("/api/wallet/topup", paymentRoutes);
app.use("/api/rma", rmaLogRoutes);
app.use("/api", withdrawalsRoutes);
app.use("/api", debugRoutes);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || "Internal server error",
  });
});

module.exports = app;
