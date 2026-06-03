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

const { prisma } = require("./lib/prisma");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");
const store = require("./models/chatStoreRedis");

const app = express();

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);

/* -------------------- static uploads -------------------- */
// Serve uploads from BOTH paths
app.use("/uploads", express.static(upload.UPLOAD_ROOT));
app.use("/chat/uploads", express.static(upload.UPLOAD_ROOT));

/* -------------------- health -------------------- */
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return res.json({
      ok: true,
      prisma: "connected",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      prisma: "disconnected",
      error: e?.message || "Prisma connection failed",
    });
  }
});

app.get("/", (_req, res) =>
  res.json({
    ok: true,
    service: "user_merchant_chat",
  }),
);

/* -------------------- routes -------------------- */
app.use("/chat", chatRoutes);

/* -------------------- server + socket -------------------- */
const server = http.createServer(app);

// Socket path under /chat
const io = new Server(server, {
  path: "/chat/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

app.set("io", io);

/* -------------------- Redis adapter -------------------- */
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.warn("[socket] REDIS_URL missing. Live chat across pods will NOT work.");
} else {
  const pubClient = new Redis(REDIS_URL);
  const subClient = pubClient.duplicate();

  pubClient.on("connect", () => {
    console.log("[redis pub] connected");
  });

  subClient.on("connect", () => {
    console.log("[redis sub] connected");
  });

  pubClient.on("error", (e) => {
    console.error("[redis pub] error", e?.message || e);
  });

  subClient.on("error", (e) => {
    console.error("[redis sub] error", e?.message || e);
  });

  io.adapter(createAdapter(pubClient, subClient));

  console.log("[socket] redis adapter enabled");
}

/* -------------------- socket rooms -------------------- */
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
   AUTO CLEANUP LOOP
   - polls delivered_orders using Prisma
   - deletes chat in Redis
   - deletes uploaded chat images
   - uses Redis lock so only ONE pod runs cleanup per interval
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
// - /uploads/chat/xxx.jpg
// - /chat/uploads/chat/xxx.jpg
// - https://grab.newedge.bt/chat/uploads/chat/xxx.jpg
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
  if (s.startsWith("/chat/uploads/")) {
    s = s.replace(/^\/chat\/uploads\//, "/uploads/");
  }

  // only delete chat files
  if (!s.startsWith("/uploads/chat/")) {
    return null;
  }

  const filename = s.split("/").pop();

  if (!filename) return null;

  return path.join(upload.UPLOAD_ROOT, "chat", filename);
}

/* -------------------- Prisma helpers -------------------- */

function prismaModelExists(modelName) {
  try {
    return !!prisma?._runtimeDataModel?.models?.[modelName];
  } catch {
    return false;
  }
}

function prismaModelFields(modelName) {
  try {
    const model = prisma?._runtimeDataModel?.models?.[modelName];

    if (!model || !Array.isArray(model.fields)) {
      return new Set();
    }

    return new Set(model.fields.map((f) => f.name));
  } catch {
    return new Set();
  }
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

function buildDeliveredSelect() {
  const fields = prismaModelFields("delivered_orders");

  const select = {
    order_id: true,
  };

  if (fields.has("created_at")) {
    select.created_at = true;
  }

  if (fields.has("delivered_at")) {
    select.delivered_at = true;
  }

  if (fields.has("chat_cleaned")) {
    select.chat_cleaned = true;
  }

  if (fields.has("is_chat_cleaned")) {
    select.is_chat_cleaned = true;
  }

  if (fields.has("cleaned")) {
    select.cleaned = true;
  }

  return select;
}

function buildDeliveredOrderBy() {
  const fields = prismaModelFields("delivered_orders");

  if (fields.has("delivered_id")) {
    return [{ delivered_id: "desc" }];
  }

  if (fields.has("id")) {
    return [{ id: "desc" }];
  }

  if (fields.has("created_at")) {
    return [{ created_at: "desc" }];
  }

  if (fields.has("delivered_at")) {
    return [{ delivered_at: "desc" }];
  }

  return [{ order_id: "desc" }];
}

function buildDeliveredWhere() {
  const fields = prismaModelFields("delivered_orders");

  if (fields.has("chat_cleaned")) {
    return {
      OR: [{ chat_cleaned: false }, { chat_cleaned: 0 }],
    };
  }

  if (fields.has("is_chat_cleaned")) {
    return {
      OR: [{ is_chat_cleaned: false }, { is_chat_cleaned: 0 }],
    };
  }

  if (fields.has("cleaned")) {
    return {
      OR: [{ cleaned: false }, { cleaned: 0 }],
    };
  }

  // No cleaned flag exists. Redis idempotency will prevent repeat work.
  return {};
}

async function fetchDeliveredOrderIds(limit) {
  if (!prismaModelExists("delivered_orders")) {
    return {
      rows: [],
      mode: "Prisma model delivered_orders not found",
    };
  }

  const take = Math.max(1, Number(limit) || 50);

  const fields = prismaModelFields("delivered_orders");

  let mode = "fallback: delivered_orders";

  if (fields.has("chat_cleaned")) {
    mode = "chat_cleaned=false";
  } else if (fields.has("is_chat_cleaned")) {
    mode = "is_chat_cleaned=false";
  } else if (fields.has("cleaned")) {
    mode = "cleaned=false";
  }

  const rows = await prisma.delivered_orders.findMany({
    where: buildDeliveredWhere(),
    select: buildDeliveredSelect(),
    orderBy: buildDeliveredOrderBy(),
    take,
  });

  return {
    rows: rows.map(serializeRow),
    mode,
  };
}

async function markDbCleaned(orderId) {
  const oid = String(orderId || "").trim();

  if (!oid || !prismaModelExists("delivered_orders")) {
    return false;
  }

  const fields = prismaModelFields("delivered_orders");

  const data = {};

  if (fields.has("chat_cleaned")) {
    data.chat_cleaned = true;
  } else if (fields.has("is_chat_cleaned")) {
    data.is_chat_cleaned = true;
  } else if (fields.has("cleaned")) {
    data.cleaned = true;
  } else {
    return false;
  }

  try {
    const result = await prisma.delivered_orders.updateMany({
      where: {
        order_id: oid,
      },
      data,
    });

    return Number(result.count || 0) > 0;
  } catch (e) {
    logCleanup("markDbCleaned failed", {
      orderId: oid,
      error: e?.message,
    });

    return false;
  }
}

async function cleanupTick() {
  // lock: only one pod runs cleanup each tick
  if (typeof store.tryAcquireCleanupLock === "function") {
    const locked = await store.tryAcquireCleanupLock(25);
    if (!locked) return;
  }

  const batch = Math.max(1, Number(process.env.CLEANUP_BATCH_SIZE || 50));
  const graceMin = Number(process.env.CLEANUP_GRACE_MINUTES || 0);

  try {
    const { rows, mode } = await fetchDeliveredOrderIds(batch);

    if (!rows.length) return;

    logCleanup("poll", {
      found: rows.length,
      mode,
    });

    for (const r of rows) {
      const orderId = String(r.order_id || "").trim();

      if (!orderId) continue;

      // Optional grace period if delivered_orders has created_at/delivered_at
      const graceDate = r.created_at || r.delivered_at || null;

      if (graceMin > 0 && graceDate) {
        const ageMs = Date.now() - new Date(graceDate).getTime();

        if (ageMs < graceMin * 60 * 1000) {
          continue;
        }
      }

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

          if (paths.length) {
            logCleanup("deleted files", {
              orderId,
              deleted,
              attempted: paths.length,
            });
          }

          return deleted;
        },
      });

      if (result.deleted) {
        if (typeof store.markOrderCleaned === "function") {
          await store.markOrderCleaned(orderId);
        }

        await markDbCleaned(orderId);

        logCleanup("deleted chat", result);
      }
    }
  } catch (e) {
    logCleanup("ERROR", {
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
    });
  }
}

function startCleanupLoop() {
  const enabled = String(process.env.CLEANUP_ENABLED || "1") === "1";

  if (!enabled) {
    logCleanup("disabled (CLEANUP_ENABLED!=1)");
    return null;
  }

  const pollSec = Math.max(10, Number(process.env.CLEANUP_POLL_SECONDS || 60));

  logCleanup("started", {
    pollSec,
    batch: process.env.CLEANUP_BATCH_SIZE || 50,
    graceMin: process.env.CLEANUP_GRACE_MINUTES || 0,
    uploadRoot: upload.UPLOAD_ROOT,
  });

  setTimeout(() => cleanupTick().catch(() => null), 5000);

  const timer = setInterval(
    () => cleanupTick().catch(() => null),
    pollSec * 1000,
  );

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return timer;
}

/* -------------------- Prisma connection check -------------------- */

async function checkPrismaConnection() {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    console.log("[prisma] connected successfully");

    return true;
  } catch (e) {
    console.error("[prisma] connection failed", {
      message: e?.message,
      code: e?.code,
    });

    return false;
  }
}

/* -------------------- graceful shutdown -------------------- */

async function shutdown(signal) {
  console.log(`[server] received ${signal}. Shutting down...`);

  try {
    server.close(() => {
      console.log("[server] HTTP server closed");
    });
  } catch (e) {
    console.error("[server] close error", e?.message || e);
  }

  try {
    await prisma.$disconnect();
    console.log("[prisma] disconnected");
  } catch (e) {
    console.error("[prisma] disconnect error", e?.message || e);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* -------------------- listen -------------------- */

const PORT = Number(process.env.PORT || 4010);

async function startServer() {
  const prismaOk = await checkPrismaConnection();

  if (!prismaOk) {
    console.error("[server] Startup aborted because Prisma could not connect.");
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`chat running on port number:${PORT}`);
    startCleanupLoop();
  });
}

startServer().catch((e) => {
  console.error("[server] fatal startup error", {
    message: e?.message,
    code: e?.code,
    stack: e?.stack,
  });

  process.exit(1);
});