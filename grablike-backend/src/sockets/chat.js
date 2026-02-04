// src/socket/chat.js
// Ride-room chat stored in Redis (no MySQL writes).
// - Membership is still checked against MySQL rides table for security.
// - Messages live in Redis Sorted Set per ride (score = monotonic msg id).

import { getRedis } from "../matching/redis.js";

const ROOM = {
  ride: (rideId) => `ride:${rideId}`,
};

function ackOk(ack, data = {}) {
  try {
    if (typeof ack === "function") ack({ ok: true, ...data });
  } catch {}
}
function ackFail(ack, error = "error") {
  try {
    if (typeof ack === "function") ack({ ok: false, error });
  } catch {}
}
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/* -------- Redis keys -------- */
function msgKey(rideId) {
  return `chat:ride:${rideId}:z`;
}
function seqKey(rideId) {
  return `chat:ride:${rideId}:seq`;
}
function readKey(rideId, role, uid) {
  return `chat:ride:${rideId}:read:${role}:${uid}`;
}

/* -------- Utils -------- */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function toOut(m) {
  return {
    id: Number(m.id),
    request_id: Number(m.request_id),
    sender_type: m.sender_type,
    sender_id: m.sender_id != null ? Number(m.sender_id) : null,
    message: m.message || "",
    attachments: m.attachments ?? null,
    created_at: m.created_at,
  };
}
function roomSize(io, room) {
  try {
    return io.sockets.adapter.rooms.get(room)?.size ?? 0;
  } catch {
    return 0;
  }
}
function logEmit(io, room, evt, payload, extra = "") {
  const size = roomSize(io, room);
  const rid = String(
    payload?.request_id ?? payload?.message?.request_id ?? "?",
  );
  console.log(
    `[chat EMIT] ride:${rid} evt:${evt} room:${room} size:${size} ${extra}`,
  );
}

/* -------- Security: ensure membership -------- */
async function ensureRideMembership(mysqlPool, rideId, socket) {
  const conn = await mysqlPool.getConnection();
  try {
    const [[row]] = await conn.query(
      `SELECT r.driver_id, r.passenger_id, MAX(o.business_id) AS merchant_id
       FROM rides r
       LEFT JOIN orders o ON o.delivery_ride_id = r.ride_id
       WHERE r.ride_id = ?
       GROUP BY r.driver_id, r.passenger_id`,
      [rideId],
    );
    if (!row) return { ok: false, reason: "ride_not_found" };

    const role = socket.data?.role;
    if (role === "driver") {
      const did = Number(socket.data?.driver_id);
      if (!did || Number(row.driver_id) !== did) {
        console.warn(
          `[chat SEC] ride:${rideId} not_member_driver (did=${did}, row.did=${row.driver_id})`,
        );
        return { ok: false, reason: "not_member_driver" };
      }
      return {
        ok: true,
        role: "driver",
        selfId: did,
        otherId: Number(row.passenger_id) || null,
      };
    }
    if (role === "passenger") {
      const pid = Number(socket.data?.passenger_id);
      if (!pid || Number(row.passenger_id) !== pid) {
        console.warn(
          `[chat SEC] ride:${rideId} not_member_passenger (pid=${pid}, row.pid=${row.passenger_id})`,
        );
        return { ok: false, reason: "not_member_passenger" };
      }
      return {
        ok: true,
        role: "passenger",
        selfId: pid,
        otherId: Number(row.driver_id) || null,
      };
    }
    if (role === "merchant") {
      const mid = Number(socket.data?.merchant_id);
      const merchantIdFromRide = Number(row.merchant_id); // join rides→merchants if needed
      if (!mid || merchantIdFromRide !== mid) {
        console.warn(
          `[chat SEC] ride:${rideId} not_member_merchant (mid=${mid}, row.mid=${merchantIdFromRide})`,
        );
        return { ok: false, reason: "not_member_merchant" };
      }
      return {
        ok: true,
        role: "merchant",
        selfId: mid,
        otherId: Number(row.driver_id) || null,
      };
    }

    console.warn(
      `[chat SEC] ride:${rideId} unknown_role (socket role=${role})`,
    );
    return { ok: false, reason: "unknown_role" };
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

/* ======================================================================== */
/*                              Chat initializer                             */
/* ======================================================================== */
export function initRideChat(io, mysqlPool, socket) {
  const r = getRedis();

  console.log(
    `[chat BOOT] socket:${socket.id} role:${socket.data?.role} d:${socket.data?.driver_id ?? "-"} p:${socket.data?.passenger_id ?? "-"}`,
  );

  /* ---------------------- JOIN ---------------------- */
  socket.on("chat:join", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    try {
      if (!rideId) return ackFail(ack, "request_id_required");
      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      const room = ROOM.ride(rideId);
      await socket.join(room);

      const size = roomSize(io, room);
      console.log(
        `[chat JOIN] ride:${rideId} room:${room} size:${size} by ${mem.role}:${mem.selfId}`,
      );
      ackOk(ack, { room, size });
    } catch (e) {
      console.error("[chat ERROR] chat:join", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- LEAVE ---------------------- */
  socket.on("chat:leave", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    try {
      if (!rideId) return ackFail(ack, "request_id_required");
      const room = ROOM.ride(rideId);
      await socket.leave(room);

      const size = roomSize(io, room);
      console.log(`[chat LEAVE] ride:${rideId} room:${room} size:${size}`);
      ackOk(ack, { room, size });
    } catch (e) {
      console.error("[chat ERROR] chat:leave", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- SEND ---------------------- */
  socket.on("chat:send", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    console.log(
      `[chat RECV] chat:send ride:${rideId} from socket:${socket.id} payload=`,
      payload,
    );

    try {
      const text =
        typeof payload.message === "string" ? payload.message.trim() : "";
      const attachments = payload.attachments ?? null;
      const temp_id = payload.temp_id || null;

      if (!rideId) return ackFail(ack, "request_id_required");
      if (!text && !attachments) return ackFail(ack, "empty_message");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      // ⬅️ defensive join so sender is in the room even if client forgot to join
      const room = ROOM.ride(rideId);
      await socket.join(room);

      const id = await r.incr(seqKey(rideId));
      const messageObj = {
        id,
        request_id: rideId,
        sender_type: mem.role,
        sender_id: mem.selfId || null,
        message: text || "",
        attachments: attachments || null,
        created_at: nowIso(),
      };

      await r.zadd(msgKey(rideId), id, JSON.stringify(messageObj));
      console.log(
        `[chat STORE] ride:${rideId} msgId:${id} by:${mem.role} uid:${mem.selfId} textLen:${(text || "").length}`,
      );

      const out = toOut(messageObj);
      logEmit(io, room, "chat:new", { message: out, temp_id });
      io.to(room).emit("chat:new", { message: out, temp_id });

      ackOk(ack, { message: out, temp_id });
    } catch (e) {
      console.error("[chat ERROR] chat:send", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* --------------------- HISTORY --------------------- */
  socket.on("chat:history", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    console.log(
      `[chat RECV] chat:history ride:${rideId} from socket:${socket.id} payload=`,
      payload,
    );

    try {
      const beforeId =
        payload.before_id != null ? Number(payload.before_id) : null;
      const limit = Math.min(200, Math.max(1, Number(payload.limit || 50)));
      if (!rideId) return ackFail(ack, "request_id_required");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      // ⬅️ defensive join so the history caller is in the room going forward
      const room = ROOM.ride(rideId);
      await socket.join(room);

      const maxScore = Number.isFinite(beforeId) ? beforeId - 1 : "+inf";
      const rows = await r.zrevrangebyscore(
        msgKey(rideId),
        maxScore,
        "-inf",
        "LIMIT",
        0,
        limit,
      );
      const messages = rows.map(safeParse).filter(Boolean).map(toOut).reverse();

      console.log(
        `[chat OK] history ride:${rideId} -> ${messages.length} msgs (limit=${limit}, before=${beforeId ?? "∞"})`,
      );
      ackOk(ack, { messages });
    } catch (e) {
      console.error("[chat ERROR] chat:history", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- TYPING --------------------- */
  socket.on("chat:typing", async (payload = {}) => {
    const rideId = Number(payload.request_id);
    const is_typing = !!payload.is_typing;
    const role = socket.data?.role || "unknown";
    const id =
      role === "driver" ? socket.data?.driver_id : socket.data?.passenger_id;

    if (!rideId) return;
    const room = ROOM.ride(rideId);
    logEmit(
      io,
      room,
      "chat:typing",
      { request_id: rideId },
      `(from ${role}:${id})`,
    );
    socket.to(room).emit("chat:typing", {
      request_id: rideId,
      from: { role, id: id || null },
      is_typing,
    });
  });

  /* -------------------- READ RECEIPT ------------------- */
  socket.on("chat:read", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    const lastId = Number(payload.last_seen_id || 0);
    console.log(
      `[chat RECV] chat:read ride:${rideId} last_seen_id:${lastId} socket:${socket.id}`,
    );

    try {
      if (!rideId || !Number.isFinite(lastId)) return ackFail(ack, "bad_args");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      await r.hset(readKey(rideId, mem.role, mem.selfId), {
        last_seen_id: String(lastId),
        seen_at: nowIso(),
      });

      const room = ROOM.ride(rideId);
      logEmit(
        io,
        room,
        "chat:read",
        { request_id: rideId, last_seen_id: lastId },
        `(reader ${mem.role}:${mem.selfId})`,
      );
      socket.to(room).emit("chat:read", {
        request_id: rideId,
        reader: { role: mem.role, id: mem.selfId },
        last_seen_id: lastId,
      });

      ackOk(ack);
    } catch (e) {
      console.error("[chat ERROR] chat:read", e?.message);
      ackFail(ack, "server_error");
    }
  });
}
