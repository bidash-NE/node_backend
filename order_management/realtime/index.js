// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");

let io = null;
const events = new EventEmitter();
events.setMaxListeners(0);

/* ───────── rooms ───────── */
const roomUser = (id) => `user:${id}`;
const roomBusiness = (bid) => `business:${bid}`;

/* ───────── online checks ───────── */
function isBusinessOnline(business_id) {
  if (!io) return false;
  const set = io.sockets.adapter.rooms.get(roomBusiness(business_id));
  return !!(set && set.size > 0);
}

/* ───────── attach ───────── */
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

    // Always join the user's personal room
    socket.join(roomUser(user_id));

    // Merchants (store/staff sessions) join one or many business rooms
    if (role === "merchant") {
      const auth = socket.handshake.auth || {};
      let bids = [];

      // Prefer new fields
      if (Array.isArray(auth.business_ids))
        bids = auth.business_ids.map(Number);
      else if (auth.business_id != null) bids = [Number(auth.business_id)];
      // Backward compat: if old clients still send merchantId, treat it as business_id
      else if (auth.merchantId != null) bids = [Number(auth.merchantId)];

      bids = bids.filter((b) => Number.isFinite(b) && b > 0);
      bids.forEach((bid) => socket.join(roomBusiness(bid)));

      socket.on("business:notify:delivered", () => {
        // placeholder for future delivered/seen events
      });
    }

    // Optional: per-order room for granular updates
    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(`order:${orderId}`);
    });
  });
}

/* ───────── notifications (business-scoped) ───────── */
/**
 * Insert+emit has moved to business_id semantics.
 * Backward compat: if caller passes merchant_id, we treat it as business_id.
 * DB insert itself is handled elsewhere; this function is the emitter.
 */
async function insertAndEmitNotification({
  business_id,
  merchant_id, // backward compat alias (treated as business_id)
  user_id,
  order_id,
  title,
  body_preview,
  type = "order:create",
  totals = null,
}) {
  const bid = Number(business_id ?? merchant_id ?? 0);
  if (!bid || !user_id || !order_id || !type || !title || !body_preview) {
    throw new Error("insertAndEmitNotification: missing required fields");
  }

  const notification_id = randomUUID();

  if (io && isBusinessOnline(bid)) {
    io.to(roomBusiness(bid)).emit("notify", {
      id: notification_id,
      type,
      orderId: order_id,
      business_id: bid,
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

/* ───────── status broadcasting ───────── */
/**
 * Emit order status to:
 *  - per-order room
 *  - the user room
 *  - all affected business rooms
 */
function broadcastOrderStatusToMany({
  order_id,
  user_id,
  business_ids = [], // ✅ new param (array)
  status,
}) {
  const ev = {
    id: randomUUID(),
    type: "order:status",
    orderId: order_id,
    createdAt: Date.now(),
    data: { status },
  };

  // Per-order room
  io?.to?.(`order:${order_id}`)?.emit?.("order:status", ev);

  // User room
  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  // Business rooms
  if (io) {
    const bids = Array.isArray(business_ids) ? business_ids : [business_ids];
    for (const bidRaw of bids) {
      const bid = Number(bidRaw);
      if (!Number.isFinite(bid) || bid <= 0) continue;
      const set = io.sockets.adapter.rooms.get(roomBusiness(bid));
      if (set?.size) io.to(roomBusiness(bid)).emit("order:status", ev);
    }
  }
}

module.exports = {
  attachRealtime,
  insertAndEmitNotification, // now business-scoped, merchant_id is alias only
  broadcastOrderStatusToMany, // expects { business_ids: [...] }
  events,

  // Exported for tests/other modules if needed
  roomUser,
  roomBusiness,
  isBusinessOnline,
};
