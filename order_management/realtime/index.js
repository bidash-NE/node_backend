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

async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"], // remove to allow polling fallback if needed
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

    // always join the user private room
    socket.join(roomUser(user_id));

    if (role === "merchant") {
      // accept business_id, legacy merchantId, or business_ids[]
      const auth = socket.handshake.auth || {};
      let mids = [];
      if (Array.isArray(auth.business_ids)) {
        mids = auth.business_ids.map(Number);
      } else if (auth.business_id != null) {
        mids = [Number(auth.business_id)];
      } else if (auth.merchantId != null) {
        mids = [Number(auth.merchantId)]; // legacy
      } else {
        // fallback: fetch merchant businesses for this user
        mids = await getMerchantIdsForUser(user_id);
      }
      mids = mids.filter((m) => Number.isFinite(m) && m > 0);

      // just join rooms — NO REPLAY, NO delivered_at changes here
      mids.forEach((mid) => socket.join(roomMerchant(mid)));

      // optional: keep ACK listener removed or keep as no-op
      socket.on("merchant:notify:delivered", async (_payload) => {
        // Intentionally do nothing (you said no delivered_at updates / replay)
        // If you later want to mark as delivered, uncomment:
        // const id = _payload?.id;
        // if (!id) return;
        // await db.query(`UPDATE order_notification SET delivered_at = NOW() WHERE notification_id = ?`, [String(id)]);
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
  const [rows] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE user_id = ?`,
    [user_id]
  );
  return rows.map((r) => r.business_id);
}

/** Durable notification + conditional emit (only if merchant online).
 *  No replay. No auto delivered_at updates.
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

  // Always persist (so merchant UI can fetch via REST)
  await db.query(
    `
    INSERT INTO order_notification
      (notification_id, order_id, merchant_id, user_id, type, title, body_preview, delivered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NOW())
    `,
    [notification_id, order_id, merchant_id, user_id, type, title, body_preview]
  );

  // Emit only if merchant is currently online
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

/** Broadcast order status to user + merchant rooms (only if online).
 *  No replay — if offline, they’ll see it via REST later.
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

  // optional order room
  io?.to(roomOrder(order_id)).emit("order:status", ev);

  // user
  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  // merchant(s)
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
