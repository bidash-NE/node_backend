// File: server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const path = require("path");
const fs = require("fs/promises");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");
const store = require("./models/chatStoreRedis");

// ✅ your mysql pool (module.exports = pool)
const db = require("./config/db");

const app = express();
app.use(cors({ origin: "*", credentials: true }));

/* -------------------- static uploads -------------------- */
// ✅ serve uploads from BOTH paths (prod-safe)
app.use("/uploads", express.static(upload.UPLOAD_ROOT));
app.use("/chat/uploads", express.static(upload.UPLOAD_ROOT));

/* -------------------- health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "user_merchant_chat" }),
);

/* -------------------- routes -------------------- */
app.use("/chat", chatRoutes);

/* -------------------- server + socket -------------------- */
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
if (!REDIS_URL) {
  console.warn("[socket] REDIS_URL missing (live across pods will NOT work)");
} else {
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

  socket.on("chat:leave", ({ conversationId }) => {
    if (!conversationId) return;
    const room = `chat:conv:${conversationId}`;
    socket.leave(room);
    console.log("[socket] leave", room, "socket=", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", socket.id);
  });
});

/* =========================================================
   ✅ AUTO CLEANUP LOOP (no DB schema changes, no new k8s job)
   - polls delivered_orders
   - if order_id exists => delete chat in redis + delete images from PVC
   - uses redis lock so only ONE pod runs cleanup each interval
   ========================================================= */

function logCleanup(...a) {
  console.log(`[${new Date().toISOString()}] [cleanup]`, ...a);
}

async function safeUnlink(p) {
  try {
    await fs.unlink(p);
    return true;
  } catch {
    return false;
  }
}

// mediaUrl examples:
//  - /uploads/chat/xxx.jpg
//  - /chat/uploads/chat/xxx.jpg
//  - https://grab.newedge.bt/chat/uploads/chat/xxx.jpg
function mediaUrlToDiskPath(mediaUrl) {
  if (!mediaUrl) return null;
  let s = String(mediaUrl).trim();
  if (!s) return null;

  // strip scheme/host if present
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      s = new URL(s).pathname;
    }
  } catch {}

  // normalize to /uploads/...
  if (s.startsWith("/chat/uploads/"))
    s = s.replace(/^\/chat\/uploads\//, "/uploads/");

  // only delete chat files
  if (!s.startsWith("/uploads/chat/")) return null;

  const filename = s.split("/").pop();
  if (!filename) return null;

  return path.join(upload.UPLOAD_ROOT, "chat", filename);
}

// Try common delivered_orders column variants without schema change
async function fetchDeliveredOrderIds(limit) {
  const sqlVariants = [
    `SELECT order_id FROM delivered_orders ORDER BY id DESC LIMIT ?`,
    `SELECT order_id FROM delivered_orders ORDER BY created_at DESC LIMIT ?`,
    `SELECT order_id FROM delivered_orders LIMIT ?`,
  ];

  for (const sql of sqlVariants) {
    try {
      const [rows] = await db.query(sql, [limit]);
      return { rows, sql };
    } catch (e) {
      if (String(e.code) === "ER_BAD_FIELD_ERROR") continue;
      throw e;
    }
  }

  return { rows: [], sql: "none" };
}

async function cleanupTick() {
  // lock (only one pod runs cleanup each tick)
  if (typeof store.tryAcquireCleanupLock === "function") {
    const locked = await store.tryAcquireCleanupLock(25);
    if (!locked) return;
  }

  const batch = Math.max(1, Number(process.env.CLEANUP_BATCH_SIZE || 50));

  try {
    const { rows, sql } = await fetchDeliveredOrderIds(batch);
    if (!rows.length) return;

    logCleanup("poll", { found: rows.length, sql });

    for (const r of rows) {
      const orderId = String(r.order_id || "").trim();
      if (!orderId) continue;

      if (typeof store.wasOrderCleaned === "function") {
        if (await store.wasOrderCleaned(orderId)) continue;
      }

      const result = await store.deleteConversationByOrderId(orderId, {
        deleteFiles: async (mediaUrls) => {
          const paths = [
            ...new Set(
              (mediaUrls || []).map(mediaUrlToDiskPath).filter(Boolean),
            ),
          ];
          let deleted = 0;
          for (const p of paths) {
            const ok = await safeUnlink(p);
            if (ok) deleted++;
          }
          if (paths.length)
            logCleanup("deleted files", {
              orderId,
              deleted,
              attempted: paths.length,
            });
        },
      });

      if (result.deleted) {
        if (typeof store.markOrderCleaned === "function") {
          await store.markOrderCleaned(orderId);
        }
        logCleanup("deleted chat", result);
      }
    }
  } catch (e) {
    logCleanup("ERROR", e?.message || e);
  }
}

function startCleanupLoop() {
  const enabled = String(process.env.CLEANUP_ENABLED || "1") === "1";
  if (!enabled) {
    logCleanup("disabled (CLEANUP_ENABLED!=1)");
    return;
  }

  const pollSec = Math.max(10, Number(process.env.CLEANUP_POLL_SECONDS || 60));
  logCleanup("started", {
    pollSec,
    batch: process.env.CLEANUP_BATCH_SIZE || 50,
    uploadRoot: upload.UPLOAD_ROOT,
  });

  setTimeout(() => cleanupTick().catch(() => null), 5000);
  setInterval(() => cleanupTick().catch(() => null), pollSec * 1000);
}

/* -------------------- listen -------------------- */
const PORT = Number(process.env.PORT || 4010);
server.listen(PORT, () => {
  console.log(`chat running on port :${PORT}`);
  startCleanupLoop();
});
