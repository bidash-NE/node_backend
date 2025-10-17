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

// online check for a merchant business room
function isMerchantOnline(merchant_id) {
  if (!io) return false;
  const set = io.sockets.adapter.rooms.get(roomMerchant(merchant_id));
  return !!(set && set.size > 0);
}

async function getMerchantIdsForUser(user_id) {
  const [rows] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE user_id = ?`,
    [user_id]
  );
  return rows.map((r) => r.business_id);
}

async function getUserIdForOrder(order_id) {
  const [[row]] = await db.query(
    `SELECT user_id FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id]
  );
  return row ? row.user_id : null;
}

async function getMerchantIdsForOrder(order_id) {
  const [rows] = await db.query(
    `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
    [order_id]
  );
  return rows.map((r) => r.business_id);
}

async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"], // allow polling by removing this line if needed
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

  // 🔓 dev no-auth (turn OFF in prod)
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
        mids = [Number(auth.merchantId)]; // legacy alias
      } else {
        mids = await getMerchantIdsForUser(user_id);
      }
      mids = mids.filter((m) => Number.isFinite(m) && m > 0);
      mids.forEach((mid) => socket.join(roomMerchant(mid)));

      socket.on("merchant:notify:delivered", async (_payload) => {
        // no-op; keep for future if you want to mark delivered_at
      });

      // Allow merchant to emit status over socket (optional fast path)
      socket.on("order:status", async ({ orderId, status, reason }) => {
        try {
          if (!orderId || !status) return;
          const ALLOWED_STATUSES = new Set([
            "PENDING",
            "REJECTED",
            "CONFIRMED",
            "PREPARING",
            "READY",
            "OUT_FOR_DELIVERY",
            "COMPLETED",
            "CANCELLED",
          ]);
          const normalized = String(status).trim().toUpperCase();
          if (!ALLOWED_STATUSES.has(normalized)) return;

          const [uid, midsForOrder] = await Promise.all([
            getUserIdForOrder(orderId),
            getMerchantIdsForOrder(orderId),
          ]);
          broadcastOrderStatusToMany({
            order_id: orderId,
            user_id: uid,
            merchant_ids: midsForOrder,
            status: normalized,
          });
        } catch (e) {
          console.warn("[SOCKET] order:status handler failed:", e.message);
        }
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

/** Durable notification + conditional emit (only if merchant online)
 * totals: { items_subtotal, platform_fee_total, delivery_fee_total, discount_amount, total_amount }
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

  await db.query(
    `
    INSERT INTO order_notification
      (notification_id, order_id, merchant_id, user_id, type, title, body_preview, delivered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NOW())
    `,
    [notification_id, order_id, merchant_id, user_id, type, title, body_preview]
  );

  if (io && isMerchantOnline(merchant_id)) {
    const payload = {
      id: notification_id,
      type,
      orderId: order_id,
      createdAt: Date.now(),
      data: {
        title,
        body: body_preview,
        ...(totals ? { totals } : {}),
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

  // Order room (optional)
  io?.to(roomOrder(order_id)).emit("order:status", ev);

  // User
  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  // Merchants
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
