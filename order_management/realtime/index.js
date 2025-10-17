// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");

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

function isMerchantOnline(merchant_id) {
  if (!io) return false;
  const set = io.sockets.adapter.rooms.get(roomMerchant(merchant_id));
  return !!(set && set.size > 0);
}

async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"],
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

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
      const auth = socket.handshake.auth || {};
      let mids = [];
      if (Array.isArray(auth.business_ids)) {
        mids = auth.business_ids.map(Number);
      } else if (auth.business_id != null) {
        mids = [Number(auth.business_id)];
      } else if (auth.merchantId != null) {
        mids = [Number(auth.merchantId)]; // legacy
      }
      mids = mids.filter((m) => Number.isFinite(m) && m > 0);
      mids.forEach((mid) => socket.join(roomMerchant(mid)));

      socket.on("merchant:notify:delivered", async (_payload) => {
        // no-op (you can enable delivered_at if needed)
      });

      socket.on("merchant:preorder:ack", (ack) => {
        events.emit("preorder:ack", { ...ack, _by: socket.id });
      });
    }

    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(roomOrder(orderId));
    });

    socket.on("inbox:seen", async ({ ids = [] }) => {
      // hook if you want to persist read status
    });
  });
}

/**
 * Durable notification + conditional emit (merchant must be online to receive).
 * `totals` is forwarded so merchant UI can render the exact user-facing total (e.g., 115.70).
 */
async function insertAndEmitNotification({
  merchant_id,
  user_id,
  order_id,
  title,
  body_preview,
  type = "order:create",
  totals = null,
}) {
  const notification_id = randomUUID();

  // Persist row (you may store body_preview only; totals can be derived from orders if needed)
  // Keep simple here — no delivered_at changes.
  // (If you have an order_notification table, insert there.)
  // Example (commented out if you don't use that table):
  // await db.query(
  //   `INSERT INTO order_notification
  //     (notification_id, order_id, merchant_id, user_id, type, title, body_preview, delivered_at, created_at)
  //    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NOW())`,
  //   [notification_id, order_id, merchant_id, user_id, type, title, body_preview]
  // );

  if (io && isMerchantOnline(merchant_id)) {
    const payload = {
      id: notification_id,
      type,
      orderId: order_id,
      createdAt: Date.now(),
      data: {
        title,
        body: body_preview,
        totals: totals
          ? {
              items_subtotal: Number(totals.items_subtotal || 0),
              platform_fee_total: Number(totals.platform_fee_total || 0),
              delivery_fee_total: Number(totals.delivery_fee_total || 0),
              discount_amount: Number(totals.discount_amount || 0),
              total_amount: Number(totals.total_amount || 0),
            }
          : null,
      },
    };
    io.to(roomMerchant(merchant_id)).emit("notify", payload);
  }

  return { notification_id };
}

/** Broadcast order status to user + merchant rooms (only if online). */
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

  io?.to(roomOrder(order_id)).emit("order:status", ev);

  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  if (io) {
    const mids = Array.isArray(merchant_ids) ? merchant_ids : [merchant_ids];
    for (const mid of mids) {
      const set = io.sockets.adapter.rooms.get(roomMerchant(mid));
      if (set?.size) io.to(roomMerchant(mid)).emit("order:status", ev);
    }
  }
}

module.exports = {
  attachRealtime,
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
  events,
};
