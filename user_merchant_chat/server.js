// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");

const app = express();
app.use(cors());

// ✅ Serve all uploads (licenses/logos/bank_qr/chat/misc) from UPLOAD_ROOT
app.use("/uploads", express.static(upload.UPLOAD_ROOT));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.set("io", io);

// ✅ Socket rooms
io.on("connection", (socket) => {
  socket.on("chat:join", ({ conversationId }) => {
    if (!conversationId) return;
    socket.join(`chat:conv:${conversationId}`);
  });

  socket.on("chat:leave", ({ conversationId }) => {
    if (!conversationId) return;
    socket.leave(`chat:conv:${conversationId}`);
  });
});

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "user_merchant_chat" }),
);

// ✅ Chat routes
app.use("/chat", chatRoutes);

// ✅ Multer error handler (nice errors for wrong file type/size)
app.use((err, _req, res, _next) => {
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || "Upload error",
    });
  }
  return res.status(500).json({ success: false, message: "Server error" });
});

const PORT = Number(process.env.PORT || 4010);
server.listen(PORT, () => console.log(`Chat server running on :${PORT}`));
