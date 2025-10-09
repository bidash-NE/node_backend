// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");
const db = require("../config/db");

let io = null;
const events = new EventEmitter();
events.setMaxListeners(0);

async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"],
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

  // 🔓 Force dev no-auth for easy local testing (flip off in prod)
  const DEV_NOAUTH = true;

  io.use((socket, next) => {
    try {
      if (DEV_NOAUTH) {
        const devUserId = Number(socket.handshake.auth?.devUserId || 0);
        const devRole = String(socket.handshake.auth?.devRole || "");
        if (devUserId && (devRole === "user" || devRole === "merchant")) {
          socket.user = { user_id: devUserId, role: devRole };
          console.log("[SOCKET] DEV user", socket.user);
          return next();
        }
        return next(new Error("dev no-auth: provide devUserId & devRole"));
      }

      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers["x-access-token"];
      if (!token) return next(new Error("no token"));
      const p = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      socket.user = { user_id: p.user_id, role: p.role };
      next();
    } catch {
      next(new Error("auth failed"));
    }
  });

  io.on("connection", async (socket) => {
    const { user_id, role } = socket.user;
    console.log("[SOCKET] connected", { sid: socket.id, user_id, role });
    socket.join(`user:${user_id}`);

    if (role === "merchant") {
      let mids = [];
      if (DEV_NOAUTH && socket.handshake.auth?.merchantId) {
        mids = [Number(socket.handshake.auth.merchantId)];
      } else {
        mids = await getMerchantIdsForUser(user_id);
      }
      mids.forEach((mid) => socket.join(`merchant:${mid}`));
      console.log("[SOCKET] merchant joined rooms", mids);

      // Replay undelivered notifications for this merchant
      for (const mid of mids) {
        const [rows] = await db.query(
          `SELECT notification_id, order_id, type, title, body_preview, created_at
             FROM order_notification
            WHERE merchant_id = ? AND delivered_at IS NULL
            ORDER BY created_at ASC
            LIMIT 100`,
          [mid]
        );

        for (const n of rows) {
          // emit replay
          socket.emit("notify", {
            id: n.notification_id,
            type: n.type,
            orderId: n.order_id,
            createdAt: new Date(n.created_at).getTime(),
            data: { title: n.title, body: n.body_preview },
          });
          // mark as delivered immediately on replay since the merchant is online now
          await db.query(
            `UPDATE order_notification SET delivered_at = NOW() WHERE notification_id = ?`,
            [n.notification_id]
          );
        }
      }

      // Merchant acknowledges they RECEIVED a notification (for live emits)
      socket.on("merchant:notify:delivered", async ({ id }) => {
        if (!id) return;
        try {
          await db.query(
            `UPDATE order_notification SET delivered_at = NOW() WHERE notification_id = ?`,
            [String(id)]
          );
          console.log("[SOCKET] delivered_at set for", id);
        } catch (e) {
          console.warn("failed to set delivered_at:", e.message);
        }
      });

      // ACKs kept for potential future workflows (server-only)
      socket.on("merchant:preorder:ack", (ack) => {
        console.log("[SOCKET] ACK from merchant", ack);
        events.emit("preorder:ack", { ...ack, _by: socket.id });
      });
    }

    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(`order:${orderId}`);
    });

    socket.on("inbox:seen", async ({ ids = [] }) => {
      if (!ids.length) return;
      await db.query(
        `UPDATE order_notification SET is_read = 1, seen_at = NOW() WHERE notification_id IN (?)`,
        [ids]
      );
    });
  });
}

/* ---------------- helpers ---------------- */

async function getMerchantIdsForUser(user_id) {
  const [rows] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE user_id = ?`,
    [user_id]
  );
  return rows.map((r) => r.business_id);
}

/**
 * Insert durable notification row, then emit WITHOUT checking online status.
 * delivered_at is set later when the merchant client emits 'merchant:notify:delivered',
 * or during replay-on-connect (we set delivered_at immediately after replay emit).
 */
async function insertAndEmitNotification({
  merchant_id,
  user_id,
  order_id,
  title,
  body_preview,
  type = "order:create",
}) {
  const notification_id = randomUUID();

  // 1) Persist row first
  await db.query(
    `INSERT INTO order_notification
      (notification_id, order_id, merchant_id, user_id, type, title, body_preview, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [notification_id, order_id, merchant_id, user_id, type, title, body_preview]
  );

  // 2) Emit unconditionally (if merchant is offline, event is dropped; replay covers it)
  const payload = {
    id: notification_id,
    type,
    orderId: order_id,
    createdAt: Date.now(),
    data: { title, body: body_preview },
  };
  // send to the merchant's room
  const room = `merchant:${merchant_id}`;
  io.to(room).emit("notify", payload);
  console.log("[SOCKET] notify emitted (no online check)", {
    room,
    notification_id,
  });

  return { notification_id };
}

/**
 * Broadcast an order status to user, each merchant room, and order room
 */
function broadcastOrderStatusToMany({
  order_id,
  user_id,
  merchant_ids = [],
  status,
}) {
  const ev = {
    id: randomUUID(),
    type: "order:status",
    orderId: order_id,
    createdAt: Date.now(),
    data: { status },
  };
  io.to(`order:${order_id}`).emit("order:status", ev);
  if (user_id) io.to(`user:${user_id}`).emit("order:status", ev);
  for (const mid of merchant_ids) {
    io.to(`merchant:${mid}`).emit("order:status", ev);
  }
}

module.exports = {
  attachRealtime,
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
};
