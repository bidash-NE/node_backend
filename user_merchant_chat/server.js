require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");

const app = express();
app.use(cors({ origin: "*", credentials: true }));

// ✅ serve uploads from BOTH paths (prod safe)
app.use("/uploads", express.static(upload.UPLOAD_ROOT));
app.use("/chat/uploads", express.static(upload.UPLOAD_ROOT));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "user_merchant_chat" }),
);

// ✅ mount your routes (keep as-is)
app.use("/chat", chatRoutes);

const server = http.createServer(app);

// ✅ IMPORTANT: socket path under /chat (works with ingress pathPrefix /chat)
const io = new Server(server, {
  path: "/chat/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.set("io", io);

// ✅ Redis adapter (works across multiple replicas)
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL)
  console.warn("[socket] REDIS_URL missing (live across pods will NOT work)");
else {
  const pubClient = new Redis(REDIS_URL);
  const subClient = pubClient.duplicate();

  pubClient.on("error", (e) =>
    console.error("[redis pub] error", e?.message || e),
  );
  subClient.on("error", (e) =>
    console.error("[redis sub] error", e?.message || e),
  );

  io.adapter(createAdapter(pubClient, subClient));
  console.log("[socket] redis adapter enabled");
}

// ✅ join rooms EXACTLY matching controller emit room name
io.on("connection", (socket) => {
  console.log("[socket] connected", socket.id);

  socket.on("chat:join", ({ conversationId }) => {
    if (!conversationId) return;
    const room = `chat:conv:${conversationId}`;
    socket.join(room);
    console.log("[socket] join", room, "socket=", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", socket.id);
  });
});

const PORT = Number(process.env.PORT || 4010);
server.listen(PORT, () => console.log(`chat running on :${PORT}`));
