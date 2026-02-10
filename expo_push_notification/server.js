const express = require("express");
const cors = require("cors");
const pushRoutes = require("./routes/pushRoutes");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/push", pushRoutes);

const port = Number(process.env.PORT || 5050);
app.listen(port, "0.0.0.0", () => console.log(`✅ running on :${port}`));
