// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");

let io = null;
const events = new EventEmitter();
events.setMaxListeners(0);

const roomUser = (id) => `user:${id}`;
const roomMerchant = (bid) => `merchant:${bid}`;
const roomOrder = (oid) => `order:${oid}`;

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
    if (!user_id) return socket.disconnect(true);

    // Each socket has at least their user room
    socket.join(roomUser(user_id));

    // Merchants can join one or many business rooms
    if (role === "merchant") {
      const auth = socket.handshake.auth || {};
      let mids = [];
      if (Array.isArray(auth.business_ids))
        mids = auth.business_ids.map(Number);
      else if (auth.business_id != null) mids = [Number(auth.business_id)];
      else if (auth.merchantId != null) mids = [Number(auth.merchantId)];
      mids = mids.filter((m) => Number.isFinite(m) && m > 0);
      mids.forEach((mid) => socket.join(roomMerchant(mid)));

      socket.on("merchant:notify:delivered", () => {}); // placeholder
    }

    // Optional: per-order room for granular updates
    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(roomOrder(orderId));
    });
  });
}

/** Sends notify with exact totals coming from controller */
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

  if (io && isMerchantOnline(merchant_id)) {
    io.to(roomMerchant(merchant_id)).emit("notify", {
      id: notification_id,
      type,
      orderId: order_id,
      createdAt: Date.now(),
      data: {
        title,
        body: body_preview,
        totals: totals
          ? {
              items_subtotal: totals.items_subtotal ?? null,
              platform_fee_total: totals.platform_fee_total ?? null,
              delivery_fee_total: totals.delivery_fee_total ?? null,
              discount_amount: totals.discount_amount ?? null,
              total_amount: totals.total_amount ?? null,
            }
          : null,
      },
    });
  }
  return { notification_id };
}

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
