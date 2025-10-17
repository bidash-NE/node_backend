// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");
const db = require("../config/db");

let io = null;
const events = new EventEmitter();
events.setMaxListeners(0);

function roomUser(userId) {
  return `user:${userId}`;
}
function roomMerchant(businessId) {
  return `merchant:${businessId}`;
}
function roomOrder(orderId) {
  return `order:${orderId}`;
}

// check if any socket is currently in the merchant room
function isMerchantOnline(merchant_id) {
  if (!io) return false;
  const set = io.sockets.adapter.rooms.get(roomMerchant(merchant_id));
  return !!(set && set.size > 0);
}

async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"], // keep if your proxy supports WS; remove to allow polling fallback
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

  // 🔓 dev no-auth (switch off in prod)
  const DEV_NOAUTH = true;

  io.use((socket, next) => {
    try {
      if (DEV_NOAUTH) {
        const devUserId = Number(socket.handshake.auth?.devUserId || 0);
        const devRole = String(socket.handshake.auth?.devRole || "");
        if (devUserId && (devRole === "user" || devRole === "merchant")) {
          socket.user = { user_id: devUserId, role: devRole };
          return next();
        }
        // allow connect but mark unauth (optional: next(new Error(...)) if you want strict)
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
    const { user_id, role } = socket.user || {};
    if (!user_id) {
      socket.disconnect(true);
      return;
    }

    socket.join(roomUser(user_id));

    if (role === "merchant") {
      // determine merchant business rooms
      let mids = [];
      if (typeof socket.handshake.auth?.merchantId !== "undefined") {
        mids = [Number(socket.handshake.auth.merchantId)];
      } else {
        mids = await getMerchantIdsForUser(user_id);
      }
      mids = mids.filter((m) => Number.isFinite(m) && m > 0);
      mids.forEach((mid) => socket.join(roomMerchant(mid)));

      // Replay undelivered notifications (at-most-once; mark delivered_at on emit)
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
          socket.emit("notify", {
            id: n.notification_id,
            type: n.type,
            orderId: n.order_id,
            createdAt: new Date(n.created_at).getTime(),
            data: { title: n.title, body: n.body_preview },
          });
          await db.query(
            `UPDATE order_notification SET delivered_at = NOW() WHERE notification_id = ?`,
            [n.notification_id]
          );
        }
      }

      socket.on("merchant:notify:delivered", async ({ id }) => {
        if (!id) return;
        try {
          await db.query(
            `UPDATE order_notification SET delivered_at = NOW() WHERE notification_id = ?`,
            [String(id)]
          );
        } catch (e) {
          console.warn("failed to set delivered_at:", e.message);
        }
      });

      socket.on("merchant:preorder:ack", (ack) => {
        events.emit("preorder:ack", { ...ack, _by: socket.id });
      });
    }

    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(roomOrder(orderId));
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
  // expects merchant_business_details(user_id, business_id)
  const [rows] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE user_id = ?`,
    [user_id]
  );
  return rows.map((r) => r.business_id);
}

/** Durable notification + conditional emit (only if merchant online) */
async function insertAndEmitNotification({
  merchant_id,
  user_id,
  order_id,
  title,
  body_preview,
  type = "order:create",
}) {
  const notification_id = randomUUID();

  // Insert durable notification first
  await db.query(
    `
    INSERT INTO order_notification
      (notification_id, order_id, merchant_id, user_id, type, title, body_preview, delivered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NOW())
    `,
    [notification_id, order_id, merchant_id, user_id, type, title, body_preview]
  );

  // Emit only if merchant is connected right now
  if (io && isMerchantOnline(merchant_id)) {
    const payload = {
      id: notification_id,
      type,
      orderId: order_id,
      createdAt: Date.now(),
      data: { title, body: body_preview },
    };
    io.to(roomMerchant(merchant_id)).emit("notify", payload);
  }

  return { notification_id };
}

/** Broadcast order status to user/merchants/order room, only to online rooms */
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

  // Order room (fire-and-forget if used in your UI)
  io?.to(roomOrder(order_id)).emit("order:status", ev);

  // User (only if room has sockets)
  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  // Merchants (only to online ones)
  if (io) {
    for (const mid of merchant_ids) {
      const set = io.sockets.adapter.rooms.get(roomMerchant(mid));
      if (set?.size) io.to(roomMerchant(mid)).emit("order:status", ev);
    }
  }
}

module.exports = {
  attachRealtime,
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
  events, // optional external use
};
