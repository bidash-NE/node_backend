require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");

const app = express();
app.use(cors());

// serve uploads
app.use("/uploads", express.static(upload.UPLOAD_ROOT));

// create server + io
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// make io available inside controllers via req.app.get("io")
app.set("io", io);

// ✅ socket join logic (MUST match controller room name)
io.on("connection", (socket) => {
  console.log("[socket] connected id=", socket.id);

  socket.on("chat:join", ({ conversationId }) => {
    if (!conversationId) return;
    const room = `chat:conv:${conversationId}`;
    socket.join(room);
    console.log("[socket] join", room, "socket=", socket.id);
  });

  socket.on("chat:leave", ({ conversationId }) => {
    if (!conversationId) return;
    const room = `chat:conv:${conversationId}`;
    socket.leave(room);
    console.log("[socket] leave", room, "socket=", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected id=", socket.id);
  });
});

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "user_merchant_chat" }),
);

// mount routes
app.use("/chat", chatRoutes);

// error handler
app.use((err, _req, res, _next) => {
  console.error("[error]", err?.message || err);
  res
    .status(400)
    .json({ success: false, message: err?.message || "Server error" });
});

const PORT = Number(process.env.PORT || 4010);
server.listen(PORT, () =>
  console.log(`Chat server running on http://localhost:${PORT}`),
);
