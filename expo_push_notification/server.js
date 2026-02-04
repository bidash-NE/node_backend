const express = require("express");
const cors = require("cors");
const pushRoutes = require("./routes/pushRoutes");

const app = express();

// ✅ CORS (allow browser tools like Hoppscotch)
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

// ✅ also okay to bind like this:
app.listen(port, "0.0.0.0", () => console.log(`✅ running on :${port}`));
