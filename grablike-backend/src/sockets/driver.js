// src/socket/driver.js
import { DriverOnlineSession } from "../models/DriverOnlineSession.js";
import { presence } from "../matching/presence.js";
import { matcher } from "../matching/matcher.js";

/* ---------------------- Dev logger ---------------------- */
const dbg = (...args) => {
  if (process.env.NODE_ENV !== "production") console.log(...args);
};

/* ---------------------- Room helpers ---------------------- */
const driverRoom = (driverId) => `driver:${driverId}`;
const passengerRoom = (passengerId) => `passenger:${passengerId}`;
const rideRoom = (rideId) => `ride:${rideId}`;
const isNum = (n) => Number.isFinite(n);

/* ---------------------- Ratings table config ---------------------- */
const RATINGS_TABLE = "ride_ratings";
const RATING_COLUMN = "rating";

/* ---------------------- Wallet config ---------------------- */
const PLATFORM_WALLET_ID = (
  process.env.PLATFORM_WALLET_ID || "NET000001"
).trim(); // may be used elsewhere
const WALLET_TBL = "wallet_transactions";
const WALLETS_TBL = "wallets";

/* ---------------------- External IDs service ---------------------- */
const WALLET_IDS_ENDPOINT = (
  process.env.WALLET_IDS_ENDPOINT || "https://grab.newedge.bt/wallet/ids/both"
).trim();
const WALLET_IDS_API_KEY = (process.env.WALLET_IDS_API_KEY || "").trim();

/* ---------------------- Small helpers ---------------------- */
const pad6 = (n) => String(n).padStart(6, "0");
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const rand = () => Math.random().toString(36).slice(2);
const genTxnId = () => `TNX${Date.now()}${rand().toUpperCase()}`;
const genJournal = () => `JRN${rand().toUpperCase()}${rand().toUpperCase()}`;

/* ---------------------- Shape DB row → client payload ---------------------- */
function toClientRide(db) {
  if (!db) return null;
  const km = db.distance_m; // meters in DB
  const min = db.duration_s;

  return {
    request_id: db.ride_id,
    driver_id: db.driver_id,
    passenger_id: db.passenger_id,
    status: db.status,

    pickup: db.pickup_place,
    dropoff: db.dropoff_place,
    pickup_lat: db.pickup_lat,
    pickup_lng: db.pickup_lng,
    dropoff_lat: db.dropoff_lat,
    dropoff_lng: db.dropoff_lng,

    distance_km: km,
    eta_min: min,
    currency: db.currency,
    fare: db.fare_cents,
    requested_at: db.requested_at,
    accepted_at: db.accepted_at,
    arrived_pickup_at: db.arrived_pickup_at,
    started_at: db.started_at,
    completed_at: db.completed_at,
    trip_type: db.trip_type || "instant",
    vehicle_type: db.service_type,
    pool_batch_id: db.pool_batch_id || null,

    driver_name: db.driver_name || null,
    driver_phone: db.driver_phone || null,
    driver_rating: db.driver_rating != null ? Number(db.driver_rating) : null,
    driver_ratings_count:
      db.driver_ratings_count != null ? Number(db.driver_ratings_count) : null,
    driver_trips: db.driver_trips != null ? Number(db.driver_trips) : null,

    vehicle_label: db.vehicle_label || null,
    vehicle_plate: db.vehicle_plate || null,
  };
}

function safeAck(cb, payload) {
  try {
    if (typeof cb === "function") cb(payload);
  } catch {}
}

/* Helper: does this driver have a *foreground* socket connected? */
function hasForegroundConn(io, driverId) {
  const room = io.sockets.adapter.rooms.get(driverRoom(driverId));
  if (!room) return false;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data?.driver_id === driverId && !s?.data?.isBg) return true;
  }
  return false;
}

/* Helper: fetch passenger_id for a ride */
async function getPassengerId(conn, request_id) {
  const [[row]] = await conn.query(
    `SELECT passenger_id FROM rides WHERE ride_id = ?`,
    [request_id]
  );
  return row?.passenger_id ?? null;
}

/* Helper: room size + stage logging */
function roomSize(io, room) {
  return io.sockets.adapter.rooms.get(room)?.size ?? 0;
}
function logStage(io, request_id, stage, passenger_id) {
  const room = rideRoom(request_id);
  const size = roomSize(io, room);
  console.log(
    `[stage emit] ride:${request_id} stage:${stage} roomSize:${size} to passenger:${
      passenger_id ?? "-"
    }`
  );
}

/* ======================================================================== */
/*                    Resolve incoming → canonical driver_id                 */
/* ======================================================================== */
async function resolveDriverId(conn, incomingId) {
  const id = Number(incomingId);
  if (!Number.isFinite(id)) return null;

  const [[byDriverId]] = await conn.query(
    "SELECT driver_id FROM drivers WHERE driver_id = ? LIMIT 1",
    [id]
  );
  if (byDriverId) return byDriverId.driver_id;

  const [[byUserId]] = await conn.query(
    "SELECT driver_id FROM drivers WHERE user_id = ? LIMIT 1",
    [id]
  );
  return byUserId?.driver_id ?? null;
}

/* ======================================================================== */
/*                         Socket lifecycle improvements                     */
/* ======================================================================== */

// Single-socket enforcement & light movement debounce
const liveSocketByDriver = new Map(); // driverId -> socketId
const lastLocByDriver = new Map(); // driverId -> { lat, lng, ts }

/* meters */
function haversine(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function shouldProcessMove(
  driverId,
  lat,
  lng,
  ts,
  minMeters = 5,
  minMs = 1500
) {
  const prev = lastLocByDriver.get(driverId);
  const moved = prev ? haversine(prev, { lat, lng }) > minMeters : true;
  const spaced = prev ? ts - prev.ts > minMs : true;
  if (moved && spaced) {
    lastLocByDriver.set(driverId, { lat, lng, ts });
    return true;
  }
  return false;
}

/* ---------------- POOL SUMMARY emitter (NEW) ---------------- */
async function emitPoolSummary(io, conn, rideId) {
  const [[sum]] = await conn.query(
    `SELECT
       r.ride_id,
       COALESCE(r.capacity_seats, 0) AS capacity_seats,
       COALESCE(r.seats_booked, 0)   AS seats_booked,
       COALESCE(SUM(CASE WHEN b.status IN ('accepted','arrived_pickup','started') THEN b.seats END),0) AS seats_confirmed
     FROM rides r
     LEFT JOIN ride_bookings b ON b.ride_id = r.ride_id
     WHERE r.ride_id = ?
     GROUP BY r.ride_id`,
    [rideId]
  );

  const [rows] = await conn.query(
    `SELECT booking_id, passenger_id, seats,
            pickup_place AS pickup, dropoff_place AS dropoff,
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            fare_cents, currency, status
       FROM ride_bookings
      WHERE ride_id = ?
        AND status IN ('accepted','arrived_pickup','started','requested')`,
    [rideId]
  );

  const sc = Number(sum?.seats_confirmed || 0);
  const capacitySafe = Math.max(3, sc);

  io.to(rideRoom(rideId)).emit("poolSummary", {
    request_id: String(rideId),
    seats_confirmed: sc,
    capacity_seats: capacitySafe,
    seats_booked: Number(sum?.seats_booked || 0),
    bookings: (rows || []).map((r) => ({
      ...r,
      booking_id: String(r.booking_id),
      request_id: String(rideId),
    })),
  });
}

/* ---------------- Earnings/Levies upsert (DRY helper) ---------------- */
async function upsertEarningsAndLevies(conn, rideId) {
  const [[cur]] = await conn.query(
    `SELECT * FROM rides WHERE ride_id = ? FOR UPDATE`,
    [rideId]
  );
  if (!cur) throw new Error("Ride not found for earnings");

  const rideCurrency = cur.currency || "BTN";
  const rideFareCents = Number(cur.fare_cents) || 0;
  const rideDriverId = Number(cur.driver_id) || null;

  const [[feeRule]] = await conn.query(
    `SELECT *
       FROM platform_fee_rules
      WHERE is_active = 1
        AND starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY priority ASC, rule_id ASC
      LIMIT 1`
  );

  const [[taxRule]] = await conn.query(
    `SELECT *
       FROM tax_rules
      WHERE is_active = 1
        AND starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY priority ASC, tax_rule_id ASC
      LIMIT 1`
  );

  let platform_fee_cents = 0;
  let fee_rule_id = null;
  const feeBaseCents = rideFareCents;

  if (feeRule) {
    fee_rule_id = feeRule.rule_id;
    const type = String(feeRule.fee_type || "fixed");
    const percentBp = Number(feeRule.fee_percent_bp) || 0;
    const fixedCents = Number(feeRule.fee_fixed_cents) || 0;

    let raw = 0;
    if (type === "percent")
      raw = Math.floor((feeBaseCents * percentBp) / 10000);
    else if (type === "fixed") raw = fixedCents;
    else if (type === "mixed")
      raw = Math.floor((feeBaseCents * percentBp) / 10000) + fixedCents;

    const minCents = Number(feeRule.min_cents) || 0;
    const maxCents = Number(feeRule.max_cents) || 0;
    if (minCents && raw < minCents) raw = minCents;
    if (maxCents && maxCents > 0 && raw > maxCents) raw = maxCents;

    platform_fee_cents = Math.max(0, raw);
  }

  let tax_cents = 0;
  let tax_rule_id = null;
  if (taxRule) {
    tax_rule_id = taxRule.tax_rule_id;
    const baseKey = String(taxRule.taxable_base || "platform_fee");
    const rateBp = Number(taxRule.rate_percent_bp) || 0;
    const inclusive = !!Number(taxRule.tax_inclusive);

    let taxableBaseCents = platform_fee_cents;
    if (baseKey === "fare_subtotal" || baseKey === "fare_after_discounts") {
      taxableBaseCents = rideFareCents;
    } else if (baseKey === "driver_earnings") {
      taxableBaseCents = Math.max(0, rideFareCents - platform_fee_cents);
    }

    if (!inclusive) {
      tax_cents = Math.floor((taxableBaseCents * rateBp) / 10000);
    } else {
      const denom = 10000 + rateBp;
      tax_cents = Math.floor(
        taxableBaseCents - Math.floor((taxableBaseCents * 10000) / denom)
      );
    }
    if (tax_cents < 0) tax_cents = 0;
  }

  const base_fare_cents = rideFareCents;
  const time_cents = 0;
  const tips_cents = 0;

  if (rideDriverId) {
    await conn.execute(
      `INSERT INTO platform_levies
         (driver_id, ride_id, platform_fee_cents, tax_cents, currency,
          fee_rule_id, tax_rule_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         platform_fee_cents = VALUES(platform_fee_cents),
         tax_cents          = VALUES(tax_cents),
         currency           = VALUES(currency),
         fee_rule_id        = VALUES(fee_rule_id),
         tax_rule_id        = VALUES(tax_rule_id),
         updated_at         = NOW()`,
      [
        rideDriverId,
        rideId,
        platform_fee_cents,
        tax_cents,
        rideCurrency,
        fee_rule_id,
        tax_rule_id,
      ]
    );
  }

  await conn.execute(
    `INSERT INTO driver_earnings
       (ride_id, driver_id, currency, base_fare_cents, time_cents, tips_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       currency        = VALUES(currency),
       base_fare_cents = VALUES(base_fare_cents),
       time_cents      = VALUES(time_cents),
       tips_cents      = VALUES(tips_cents),
       updated_at      = NOW()`,
    [
      rideId,
      rideDriverId,
      rideCurrency,
      base_fare_cents,
      time_cents,
      tips_cents,
    ]
  );

  const driver_take_home_cents = Math.max(
    0,
    base_fare_cents + time_cents + tips_cents - platform_fee_cents - tax_cents
  );

  return {
    currency: rideCurrency,
    breakdown: {
      base: base_fare_cents / 100,
      time: time_cents / 100,
      tips: tips_cents / 100,
      tax: tax_cents / 100,
      platform_fee: platform_fee_cents / 100,
    },
    driver_take_home: driver_take_home_cents / 100,
    fee_rule_id,
    tax_rule_id,
  };
}

/* ---------------- Resolve user_id + wallet_id for a driver ---------------- */
async function getDriverUserAndWallet(conn, driverId) {
  const [[row]] = await conn.query(
    `SELECT d.user_id
       FROM drivers d
      WHERE d.driver_id = ?
      LIMIT 1`,
    [driverId]
  );
  const user_id = row?.user_id ? Number(row.user_id) : null;
  if (!user_id) return { user_id: null, wallet_id: null };

  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id=? LIMIT 1`,
    [user_id]
  );
  const wallet_id = w?.wallet_id || null;
  return { user_id, wallet_id };
}

/* ---------------- Resolve user_id + wallet_id for a passenger ------------- */
async function getPassengerUserAndWallet(conn, passengerId) {
  const [[row]] = await conn.query(
    `SELECT p.user_id
       FROM users p
      WHERE p.user_id = ?
      LIMIT 1`,
    [passengerId]
  );
  const user_id = row?.user_id ? Number(row.user_id) : null;
  if (!user_id) return { user_id: null, wallet_id: null };

  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id = ? LIMIT 1`,
    [user_id]
  );
  const wallet_id = w?.wallet_id || null;
  return { user_id, wallet_id };
}

/* ===== Wallet — read/lock helpers that use the WALLETS table amounts ===== */

/** Lock a wallet row for update; returns the full row (must exist). */
async function lockWalletRow(conn, wallet_id) {
  const [rows] = await conn.query(
    `SELECT wallet_id, user_id, amount
       FROM ${WALLETS_TBL}
      WHERE wallet_id = ?
      FOR UPDATE`,
    [wallet_id]
  );
  return rows?.[0] || null;
}

/** Read current wallet amount from wallets table (no lock). */
async function getWalletAmount(conn, wallet_id) {
  const [[row]] = await conn.query(
    `SELECT amount FROM ${WALLETS_TBL} WHERE wallet_id = ? LIMIT 1`,
    [wallet_id]
  );
  return Number(row?.amount || 0);
}

/** Compute wallet balance from the wallets table (amount column). */
async function getWalletBalance(conn, wallet_id) {
  if (!wallet_id) return 0;
  return getWalletAmount(conn, wallet_id);
}

/* ---------------- Atomic passenger→driver wallet transfer ------------------ */
async function walletTransfer(
  conn,
  { from_wallet, to_wallet, amount_nu,baseFare, reason = "RIDE_PAYOUT", meta = {} }
) {
  if (!(amount_nu > 0)) return { ok: false, reason: "zero_amount" };
  if (!from_wallet || !to_wallet) return { ok: false, reason: "bad_wallet" };

  // 1) Lock both wallet rows to keep balances consistent
  const fromRow = await lockWalletRow(conn, from_wallet);
  const toRow = await lockWalletRow(conn, to_wallet);

  if (!fromRow || !toRow) {
    return {
      ok: false,
      reason: "wallet_not_found",
      missing: { from: !fromRow, to: !toRow },
    };
  }

  const from_before = Number(fromRow.amount || 0);
  const to_before = Number(toRow.amount || 0);
  const amt = Number(amount_nu);
  const base_fare = Number(baseFare);

  // 2) Sufficient funds check on passenger
  if (from_before < amt) {
    return {
      ok: false,
      reason: "insufficient_funds",
      need: amt,
      have: from_before,
    };
  }

  // 3) Update wallet amounts
  await conn.execute(
    `UPDATE ${WALLETS_TBL} SET amount = amount - ? WHERE wallet_id = ?`,
    [base_fare, from_wallet]
  );
  await conn.execute(
    `UPDATE ${WALLETS_TBL} SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, to_wallet]
  );

  const from_after = from_before - base_fare;
  const to_after = to_before + amt;

  // 4) Get journal_code + two transaction_ids from external endpoint; fallback to local gen
  let journal_code = null;
  let tx_for_passenger_dr = null; // DR
  let tx_for_driver_cr = null; // CR
  try {
    const res = await fetch(WALLET_IDS_ENDPOINT, { method: "POST" });
    if (res.ok) {
      const json = await res.json();
      const ids = json?.data?.transaction_ids;
      const jr = json?.data?.journal_code;
      if (Array.isArray(ids) && ids.length >= 2 && jr) {
        // keep order stable: first use for CR, second for DR (or vice versa — consistent per your API usage)
        tx_for_driver_cr = String(ids[0]);
        tx_for_passenger_dr = String(ids[1]);
        journal_code = String(jr);
      }
      console.log("tx_for_passenger_dr: ",tx_for_passenger_dr)
      console.log("tx_for_driver_cr: ",tx_for_driver_cr)
    }
  } catch (e) {
    // ignore; will fallback
  }
  if (!journal_code || !tx_for_driver_cr || !tx_for_passenger_dr) {
    journal_code = genJournal();
    tx_for_driver_cr = genTxnId();
    tx_for_passenger_dr = genTxnId();
  }

  const created_at = nowIso();
  const noteJson = JSON.stringify({ reason, ...meta });

  // 5) Journal rows in wallet_transactions (DR from passenger, CR to driver)
  const rows = [
    {
      transaction_id: tx_for_passenger_dr,
      journal_code,
      tnx_from: from_wallet,
      tnx_to: to_wallet,
      amount: base_fare,
      remark: "DR", // passenger debit
      note: noteJson,
      created_at,
      updated_at: created_at,
    },
    {
      transaction_id: tx_for_driver_cr,
      journal_code,
      tnx_from: from_wallet,
      tnx_to: to_wallet,
      amount: amt,
      remark: "CR", // driver credit
      note: noteJson,
      created_at,
      updated_at: created_at,
    },
  ];

  for (const r of rows) {
    await conn.execute(
      `INSERT INTO ${WALLET_TBL}
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        r.transaction_id,
        r.journal_code,
        r.tnx_from,
        r.tnx_to,
        r.amount,
        r.remark,
        r.note,
        r.created_at,
        r.updated_at,
      ]
    );
  }

  return {
    ok: true,
    journal_code,
    from_wallet,
    to_wallet,
    amount: amt,
    baseFare: base_fare,
    balances: {
      passenger_before: from_before,
      passenger_after: from_after,
      driver_before: to_before,
      driver_after: to_after,
    },
  };
}

/* ======================================================================== */
/*                             Socket bootstrap                              */
/* ======================================================================== */
export function initDriverSocket(io, mysqlPool) {
  io.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);
    dbg("[socket] handshake", {
      socket: socket.id,
      driverId: socket.handshake?.auth?.driverId ?? null,
      passengerId: socket.handshake?.auth?.passengerId ?? null,
      bg: !!socket.handshake?.auth?.bg,
    });

    socket.data = { role: "unknown", isBg: !!socket.handshake?.auth?.bg };

    const { driverId, passengerId } = socket.handshake?.auth || {};
    if (driverId != null) {
      const member = String(driverId);
      socket.data.role = "driver";
      socket.data.driver_id = member;
      socket.join(driverRoom(member));
      console.log(`[socket] driver connected via handshake: ${member}`);

      const prevId = liveSocketByDriver.get(member);
      if (prevId && prevId !== socket.id) {
        const prevSock = io.sockets.sockets.get(prevId);
        if (prevSock) {
          dbg(
            `[single-socket] kicking previous socket ${prevId} for driver ${member}`
          );
          prevSock.disconnect(true);
        }
      }
      liveSocketByDriver.set(member, socket.id);
    }
    if (passengerId != null) {
      const pid = String(passengerId);
      socket.data.role = socket.data.role === "driver" ? "driver" : "passenger";
      socket.data.passenger_id = pid;
      socket.join(passengerRoom(pid));
      console.log(`[socket] passenger connected via handshake: ${pid}`);
    }

    /* -------- Optional explicit identity event -------- */
    socket.on("whoami", ({ role, driver_id, passenger_id, bg } = {}) => {
      socket.data.role = role || "unknown";
      if (typeof bg === "boolean") socket.data.isBg = bg;

      if (role === "driver" && driver_id != null) {
        const member = String(driver_id);
        socket.data.driver_id = member;
        socket.join(driverRoom(member));

        const prevId = liveSocketByDriver.get(member);
        if (prevId && prevId !== socket.id) {
          const prevSock = io.sockets.sockets.get(prevId);
          if (prevSock) prevSock.disconnect(true);
        }
        liveSocketByDriver.set(member, socket.id);
      }
      if (role === "passenger" && passenger_id != null) {
        const pid = String(passenger_id);
        socket.data.passenger_id = pid;
        socket.join(passengerRoom(pid));
      }
    });

    /* -------- Join / Leave ride room -------- */
    socket.on("joinRide", async ({ rideId } = {}, ack) => {
      if (!rideId) {
        console.warn(`[room] ${socket.id} attempted join with missing rideId`);
        return safeAck(ack, { ok: false, error: "rideId required" });
      }
      const rid = String(rideId);
      const room = rideRoom(rid);

      socket.join(room);
      const sizeAfter = roomSize(io, room);

      let status = null;
      let ridePassengerId = null;
      if (mysqlPool?.getConnection) {
        try {
          const conn = await mysqlPool.getConnection();
          const [[row]] = await conn.query(
            `SELECT status, passenger_id FROM rides WHERE ride_id = ?`,
            [rid]
          );
          status = row?.status ?? null;
          ridePassengerId = row?.passenger_id ?? null;
          try {
            conn.release();
          } catch {}
        } catch (e) {
          console.warn("[joinRide] status lookup failed:", e?.message);
        }
      }

      console.log(
        `[room] join ride:${rid} | socket:${socket.id} role:${socket.data.role}` +
          ` joinedAsPassenger:${socket.data.passenger_id ?? "-"}` +
          ` joinedAsDriver:${socket.data.driver_id ?? "-"}` +
          ` ridePassengerId:${ridePassengerId ?? "-"} size:${sizeAfter}`
      );

      dbg(`[socket] joined ride room ${room}`);
      safeAck(ack, { ok: true, status, passenger_id: ridePassengerId });
    });

    socket.on("leaveRide", ({ rideId } = {}, ack) => {
      if (!rideId) return safeAck(ack, { ok: false, error: "rideId required" });
      const rid = String(rideId);
      const room = rideRoom(rid);
      socket.leave(room);
      const sizeAfter = roomSize(io, room);
      console.log(
        `[room] leave ride:${rid} | socket:${socket.id} role:${socket.data.role}` +
          ` passenger:${socket.data.passenger_id ?? "-"} driver:${
            socket.data.driver_id ?? "-"
          }` +
          ` size:${sizeAfter}`
      );
      dbg(`[socket] left ride room ${room}`);
      safeAck(ack, { ok: true });
    });

    /* -------- Heartbeat -------- */
    socket.on("ping", (msg) => socket.emit("pong", { msg, ts: Date.now() }));

    /* -------- Presence + location -------- */
    socket.on(
      "driverOnline",
      async (
        {
          source = "socket",
          cityId = "thimphu",
          serviceType = "bike",
          serviceCode = "default",
          lat,
          lng,
        } = {},
        ack
      ) => {
        const driver_id = socket.data.driver_id;
        if (!driver_id)
          return safeAck(ack, { ok: false, error: "No driver_id" });

        socket.data.cityId = cityId;
        socket.data.serviceType = serviceType;
        socket.data.serviceCode = serviceCode;
        socket.join(`city:${cityId}:${serviceType}`);

        try {
          await DriverOnlineSession.create({
            driver_id,
            started_at: new Date(),
            ended_at: null,
            source,
          });

          try {
            await presence.setOnline(driver_id, {
              cityId,
              serviceType,
              serviceCode,
              socketId: socket.id,
              lat: isNum(lat) ? lat : undefined,
              lng: isNum(lng) ? lng : undefined,
            });
          } catch (e) {
            console.warn("[presence.setOnline] skipped:", e.message);
          }

          safeAck(ack, { ok: true });
        } catch (err) {
          console.error("[driverOnline] error:", err);
          safeAck(ack, { ok: false, error: "Server error" });
        }
      }
    );

    socket.on("driverOffline", async (_payload, ack) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id) return safeAck(ack, { ok: false, error: "No driver_id" });
      try {
        const res = await DriverOnlineSession.updateOne(
          { driver_id, ended_at: null },
          { $set: { ended_at: new Date() } }
        );

        try {
          await presence.setOffline(driver_id, socket.id);
        } catch (e) {
          console.warn("[presence.setOffline] skipped:", e.message);
        }

        safeAck(ack, { ok: true, updated: res.modifiedCount });
      } catch (err) {
        console.error("[driverOffline] error:", err);
        safeAck(ack, { ok: false, error: "Server error" });
      }
    });

    socket.on("driverLocationUpdate", async (payload = {}, ack) => {
      const {
        driver_id: pId,
        lat,
        lng,
        heading,
        speed,
        accuracy,
        source = "foreground",
      } = payload || {};

      const member = pId || socket.data.driver_id;
      if (!member) {
        return safeAck(ack, {
          ok: false,
          error: "Missing driver_id (handshake or payload)",
        });
      }

      if (!socket.data.driver_id) {
        socket.data.driver_id = member;
        socket.join(driverRoom(member));
      }

      const cityId = socket.data.cityId || "thimphu";
      const serviceType = socket.data.serviceType || "bike";
      const serviceCode = socket.data.serviceCode || "default";

      dbg("[driverLocationUpdate]", {
        socketId: socket.id,
        driver_id: member,
        lat,
        lng,
        heading,
        speed,
        accuracy,
        source,
        cityId,
        serviceType,
        serviceCode,
        ts: new Date().toISOString(),
      });

      const isBgConn =
        !!socket.handshake?.auth?.bg ||
        socket.data.isBg ||
        source === "background";
      if (isBgConn && hasForegroundConn(io, member)) {
        return safeAck(ack, { ok: true, dropped: "bg-duplicate" });
      }

      if (isNum(lat) && isNum(lng)) {
        const ts = Date.now();
        if (!shouldProcessMove(String(member), Number(lat), Number(lng), ts)) {
          return safeAck(ack, { ok: true, dropped: "debounced" });
        }
      }

      socket.broadcast.emit("driverLocationBroadcast", {
        driver_id: member,
        lat,
        lng,
        heading,
        speed,
        accuracy,
        source,
      });

      try {
        if (isNum(lat) && isNum(lng)) {
          await presence.updateLocation(member, {
            cityId,
            serviceType,
            serviceCode,
            lat,
            lng,
          });
          const peers = await presence.getNearby({
            cityId,
            serviceType,
            serviceCode,
            lat,
            lng,
            radiusM: 3000,
            count: 25,
          });
          io.to(driverRoom(member)).emit("allDriversData", peers);
          dbg(
            `[driverLocationUpdate] peers for ${member}:`,
            peers?.length ?? 0
          );
        } else {
          io.to(driverRoom(member)).emit("allDriversData", []);
        }
      } catch (e) {
        console.warn("[presence.updateLocation] warn:", e?.message);
        if (isNum(lat) && isNum(lng)) {
          io.to(driverRoom(member)).emit("allDriversData", [
            { id: member, lat, lng },
          ]);
        }
      }

      safeAck(ack, { ok: true });
    });

    /* ===================== Core ride lifecycle ===================== */
    socket.on(
      "jobAccept",
      (payload) =>
        console.log("[evt recv] jobAccept", payload) ||
        handleJobAccept({ io, socket, mysqlPool, payload })
    );
    socket.on("jobReject", (payload) =>
      handleJobReject({ io, socket, mysqlPool, payload })
    );

    socket.on("driverArrivedPickup", (payload) => {
      console.log("[evt recv] driverArrivedPickup", payload);
      handleDriverArrivedPickup({ io, socket, mysqlPool, payload });
    });
    socket.on("driverStartTrip", (payload) => {
      console.log("[evt recv] driverStartTrip", payload);
      handleDriverStartTrip({ io, socket, mysqlPool, payload });
    });
    socket.on("driverCompleteTrip", (payload) => {
      console.log("[evt recv] driverCompleteTrip", payload);
      handleDriverCompleteTrip({ io, socket, mysqlPool, payload });
    });

    /* ===================== Matching compat ===================== */
    socket.on("offer:accept", ({ request_id }) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id || !request_id) return;
      handleJobAccept({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id },
      });
    });

    socket.on("offer:reject", ({ request_id, reason = "reject" }) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id || !request_id) return;
      handleJobReject({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id, reason },
      });
    });

    socket.on("offer:timeout", ({ request_id }) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id || !request_id) return;
      handleJobReject({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id, reason: "timeout" },
      });
    });

    // ---------------- accepted/requested -> arrived_pickup
    socket.on(
      "bookingArrived",
      async ({ request_id, booking_id } = {}, ack) => {
        const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
        const fail = (error) => safeAck(ack, { ok: false, error });

        console.log("[evt recv] bookingArrived", request_id, booking_id);
        const rideId = Number(request_id);
        const bkId = Number(booking_id);
        if (!Number.isFinite(rideId) || !Number.isFinite(bkId))
          return fail("Bad IDs");

        const conn = await mysqlPool.getConnection();
        try {
          await conn.beginTransaction();

          const [[curBk]] = await conn.query(
            `SELECT status, passenger_id FROM ride_bookings WHERE ride_id=? AND booking_id=? FOR UPDATE`,
            [rideId, bkId]
          );
          if (!curBk) {
            await conn.rollback();
            return fail("Booking not found");
          }

          const passenger_id = curBk.passenger_id ?? null;

          if (curBk.status === "arrived_pickup") {
            const [liftRes] = await conn.execute(
              `UPDATE rides
               SET status='arrived_pickup',
                   arrived_pickup_at = COALESCE(arrived_pickup_at, NOW())
             WHERE ride_id=? AND status IN ('requested','accepted')`,
              [rideId]
            );

            await emitPoolSummary(io, conn, rideId);
            await conn.commit();

            if (liftRes.affectedRows > 0) {
              io.to(rideRoom(rideId)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "arrived_pickup",
              });
              if (passenger_id)
                io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                  request_id: String(rideId),
                  stage: "arrived_pickup",
                });
            }

            const msg = {
              request_id: String(rideId),
              booking_id: String(bkId),
              stage: "arrived_pickup",
            };
            io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit(
                "bookingStageUpdate",
                msg
              );

            return ok({ info: "idempotent" });
          }

          if (!["accepted", "requested"].includes(curBk.status)) {
            await conn.rollback();
            return fail(
              `Not in a state that can arrive (current=${curBk.status})`
            );
          }

          await conn.execute(
            `UPDATE ride_bookings
             SET status='arrived_pickup', arrived_pickup_at=NOW()
           WHERE ride_id=? AND booking_id=?`,
            [rideId, bkId]
          );

          const [rideLift] = await conn.execute(
            `UPDATE rides
             SET status='arrived_pickup',
                 arrived_pickup_at = COALESCE(arrived_pickup_at, NOW())
           WHERE ride_id=? AND status IN ('requested','accepted')`,
            [rideId]
          );

          await emitPoolSummary(io, conn, rideId);
          await conn.commit();

          if (rideLift.affectedRows > 0) {
            io.to(rideRoom(rideId)).emit("rideStageUpdate", {
              request_id: String(rideId),
              stage: "arrived_pickup",
            });
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "arrived_pickup",
              });
          }

          const msg = {
            request_id: String(rideId),
            booking_id: String(bkId),
            stage: "arrived_pickup",
          };
          io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
          if (passenger_id)
            io.to(passengerRoom(passenger_id)).emit("bookingStageUpdate", msg);

          ok();
        } catch (e) {
          try {
            await conn.rollback();
          } catch {}
          console.error("[bookingArrived] error:", e?.message);
          fail("Server error");
        } finally {
          try {
            conn.release();
          } catch {}
        }
      }
    );

    // ---------------- arrived_pickup -> started
    socket.on(
      "bookingOnboard",
      async ({ request_id, booking_id } = {}, ack) => {
        const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
        const fail = (error) => safeAck(ack, { ok: false, error });

        console.log("[evt recv] bookingOnboard", request_id, booking_id);
        const rideId = Number(request_id);
        const bkId = Number(booking_id);
        if (!Number.isFinite(rideId) || !Number.isFinite(bkId))
          return fail("Bad IDs");

        const conn = await mysqlPool.getConnection();
        try {
          await conn.beginTransaction();

          const [[curBk]] = await conn.query(
            `SELECT status, passenger_id FROM ride_bookings WHERE ride_id=? AND booking_id=? FOR UPDATE`,
            [rideId, bkId]
          );
          if (!curBk) {
            await conn.rollback();
            return fail("Booking not found");
          }

          const passenger_id = curBk.passenger_id ?? null;

          if (curBk.status === "started") {
            const [rideLift] = await conn.execute(
              `UPDATE rides
               SET status='started',
                   started_at = COALESCE(started_at, NOW())
             WHERE ride_id=? AND status IN ('requested','accepted','arrived_pickup')`,
              [rideId]
            );

            await emitPoolSummary(io, conn, rideId);
            await conn.commit();

            if (rideLift.affectedRows > 0) {
              io.to(rideRoom(rideId)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "started",
              });
              if (passenger_id)
                io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                  request_id: String(rideId),
                  stage: "started",
                });
            }

            const msg = {
              request_id: String(rideId),
              booking_id: String(bkId),
              stage: "started",
            };
            io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit(
                "bookingStageUpdate",
                msg
              );

            return ok({ info: "idempotent" });
          }

          if (curBk.status !== "arrived_pickup") {
            await conn.rollback();
            return fail(
              `Not in a state that can start (current=${curBk.status})`
            );
          }

          await conn.execute(
            `UPDATE ride_bookings
             SET status='started', started_at=NOW()
           WHERE ride_id=? AND booking_id=?`,
            [rideId, bkId]
          );

          const [rideLift] = await conn.execute(
            `UPDATE rides
             SET status='started',
                 started_at = COALESCE(started_at, NOW())
           WHERE ride_id=? AND status IN ('requested','accepted','arrived_pickup')`,
            [rideId]
          );

          await emitPoolSummary(io, conn, rideId);
          await conn.commit();

          if (rideLift.affectedRows > 0) {
            io.to(rideRoom(rideId)).emit("rideStageUpdate", {
              request_id: String(rideId),
              stage: "started",
            });
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "started",
              });
          }

          const msg = {
            request_id: String(rideId),
            booking_id: String(bkId),
            stage: "started",
          };
          io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
          if (passenger_id)
            io.to(passengerRoom(passenger_id)).emit("bookingStageUpdate", msg);

          ok();
        } catch (e) {
          try {
            await conn.rollback();
          } catch {}
          console.error("[bookingOnboard] error:", e?.message);
          fail("Server error");
        } finally {
          try {
            conn.release();
          } catch {}
        }
      }
    );

    // ---------------- started -> completed (+ wallet transfer)
    async function handleDriverCompleteTrip({
      io,
      socket,
      mysqlPool,
      payload,
    }) {
      console.log(
        "[driverCompleteTrip] incoming payload:",
        JSON.stringify(payload, null, 2)
      );

      const { request_id } = payload || {};
      if (!request_id) {
        return socket.emit("fareFinalized", {
          ok: false,
          error: "Missing request_id",
        });
      }

      const conn = await mysqlPool.getConnection();
      try {
        await conn.beginTransaction();

        const [[cur]] = await conn.query(
          `SELECT * FROM rides WHERE ride_id = ? FOR UPDATE`,
          [request_id]
        );
        if (!cur) {
          await conn.rollback();
          return socket.emit("fareFinalized", {
            ok: false,
            request_id,
            error: "Ride not found",
          });
        }

        const [res] = await conn.execute(
          `UPDATE rides
              SET status = 'completed', completed_at = NOW()
            WHERE ride_id = ? AND status = 'started'`,
          [request_id]
        );
        if (!res || res.affectedRows === 0) {
          await conn.rollback();
          return socket.emit("fareFinalized", {
            ok: false,
            request_id,
            error: "Ride not in 'started' state",
          });
        }

        if (cur?.trip_type === "pool") {
          await conn.execute(
            `UPDATE ride_bookings
                SET status = 'completed', completed_at = NOW()
              WHERE ride_id = ?
                AND status = 'started'`,
            [request_id]
          );
        }

        const fare = await upsertEarningsAndLevies(conn, request_id);

        // Wallet transfer: passenger pays driver (take-home)
        const driver_id = Number(cur.driver_id);
        const passenger_id = Number(cur.passenger_id);
        const pickup_place = cur.pickup_place || "unknown";
        const dropoff_place = cur.dropoff_place || "unknown";
        const takeHome = Number(fare?.driver_take_home || 0);
        const baseFare = Number(fare?.breakdown?.base || 0);

        let walletDepositRes = { ok: false };

        if (driver_id && passenger_id && takeHome > 0) {
          const { wallet_id: driver_wallet } = await getDriverUserAndWallet(
            conn,
            driver_id
          );
          const { wallet_id: passenger_wallet } =
            await getPassengerUserAndWallet(conn, passenger_id);

          if (!driver_wallet || !passenger_wallet) {
            dbg("[walletTransfer] missing wallet(s)", {
              driver_wallet,
              passenger_wallet,
            });
            walletDepositRes = { ok: false, reason: "missing_wallet" };
          } else {
            walletDepositRes = await walletTransfer(conn, {
              from_wallet: passenger_wallet,
              to_wallet: driver_wallet,
              amount_nu: takeHome,
              baseFare:baseFare,
              reason: "RIDE_PAYOUT",
              meta: { Pickup: pickup_place, Dropoff: dropoff_place },
            });
            dbg("[walletTransfer]", walletDepositRes, {
              driver_id,
              passenger_id,
              takeHome,
            });
            if (!walletDepositRes.ok) {
              // if funds are insufficient, you can decide to rollback or keep ride completed.
              // Here we keep ride completed but surface the error in the event payload.
            }
          }
        } else {
          dbg("[walletTransfer] skipped", {
            driver_id,
            passenger_id,
            takeHome,
          });
        }

        await conn.commit();

        if (cur?.trip_type === "pool") {
          try {
            const c2 = await mysqlPool.getConnection();
            await emitPoolSummary(io, c2, request_id);
            c2.release();
          } catch {}
        }

        let passenger_id_emit = cur?.passenger_id ?? null;
        if (!passenger_id_emit) {
          try {
            const c3 = await mysqlPool.getConnection();
            const [[p]] = await c3.query(
              `SELECT passenger_id FROM rides WHERE ride_id = ?`,
              [request_id]
            );
            passenger_id_emit = p?.passenger_id ?? null;
            try {
              c3.release();
            } catch {}
          } catch {}
        }

        logStage(io, request_id, "completed", passenger_id_emit);
        io.to(rideRoom(request_id)).emit("rideStageUpdate", {
          request_id,
          stage: "completed",
        });
        if (cur?.trip_type === "pool") {
          io.to(rideRoom(request_id)).emit("bookingStageUpdate", {
            request_id,
            stage: "completed",
          });
        }
        if (passenger_id_emit) {
          io.to(passengerRoom(passenger_id_emit)).emit("rideStageUpdate", {
            request_id,
            stage: "completed",
          });
        }

        const rRoom = rideRoom(request_id);
        io.to(rRoom).emit("fareFinalized", {
          ok: true,
          request_id,
          fare,
          wallet: walletDepositRes,
        });
        if (passenger_id_emit) {
          io.to(passengerRoom(passenger_id_emit)).emit("fareFinalized", {
            ok: true,
            request_id,
            fare,
            wallet: walletDepositRes,
          });
        }
        socket.emit("fareFinalized", {
          ok: true,
          request_id,
          fare,
          wallet: walletDepositRes,
        });
      } catch (err) {
        try {
          await conn.rollback();
        } catch {}
        console.error("[driverCompleteTrip] error:", err);
        socket.emit("fareFinalized", {
          ok: false,
          request_id,
          error: "Server error",
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    }

    socket.on("driverCompleteTrip", (payload) =>
      handleDriverCompleteTrip({ io, socket, mysqlPool, payload })
    );

    /* -------- Disconnect -------- */
    socket.on("disconnect", async (reason) => {
      console.log("[socket] disconnected:", socket.id, reason);
      const id = socket.data?.driver_id;

      if (id) {
        if (liveSocketByDriver.get(id) === socket.id) {
          liveSocketByDriver.delete(id);
        }
      }

      if (socket.data.role === "driver" && id) {
        const room = io.sockets.adapter.rooms.get(driverRoom(id));
        const stillHasConn = room && room.size > 0;

        if (!stillHasConn) {
          try {
            await DriverOnlineSession.updateOne(
              { driver_id: id, ended_at: null },
              { $set: { ended_at: new Date() } }
            );
          } catch (e) {
            console.error("[disconnect] failed to close online session", e);
          }
        }

        try {
          await presence.setOffline(id, socket.id);
        } catch {}
      }
    });
  });
}
/* ======================================================================== */
/*                          Event implementations                           */
/* ======================================================================== */

/* jobAccept, jobReject, driverArrivedPickup, driverStartTrip
   stay unchanged from above (already included in this file) */
async function handleJobAccept({ io, socket, mysqlPool, payload }) {
  const where = "[jobAccept]";
  try {
    const { request_id, driver_id: rawDriverId } = payload || {};
    if (!request_id || !rawDriverId) {
      return socket.emit("jobAssigned", {
        ok: false,
        error: "Missing request_id or driver_id",
      });
    }
    if (!mysqlPool?.getConnection) {
      console.error(`${where} mysqlPool not ready`);
      return socket.emit("jobAssigned", {
        ok: false,
        error: "Server DB not ready",
      });
    }

    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      const canonicalDriverId = await resolveDriverId(conn, rawDriverId);
      if (!canonicalDriverId) {
        await conn.rollback();
        return socket.emit("jobAssigned", {
          ok: false,
          request_id,
          error: `Driver not found for id ${rawDriverId}`,
        });
      }

      // 1) accept the ride
      const [res] = await conn.execute(
        `
          UPDATE rides
             SET driver_id = ?,
                 status = 'accepted',
                 accepted_at = NOW(),
                 offer_driver_id = NULL,
                 offer_expire_at = NULL
           WHERE ride_id = ?
             AND status IN ('offered_to_driver','requested')
        `,
        [canonicalDriverId, request_id]
      );
      if (!res || res.affectedRows === 0) {
        await conn.rollback();
        return socket.emit("jobAssigned", {
          ok: false,
          request_id,
          error: "Ride no longer available",
        });
      }

      // 2) read ride & enrich
      const [[ride]] = await conn.query(
        `
          SELECT
            r.ride_id, r.driver_id, r.passenger_id, r.status,
            r.pickup_place, r.dropoff_place, r.pickup_lat, r.pickup_lng,
            r.dropoff_lat, r.dropoff_lng, r.distance_m, r.duration_s, r.currency,
            r.fare_cents, r.requested_at, r.accepted_at, r.arrived_pickup_at,
            r.started_at, r.completed_at, r.service_type, r.trip_type, r.pool_batch_id,

            u.user_name  AS driver_name,
            u.phone      AS driver_phone,

            (SELECT COUNT(*) FROM rides rr WHERE rr.driver_id = r.driver_id AND rr.status = 'completed') AS driver_trips,
            (SELECT ROUND(AVG(${RATING_COLUMN}), 2) FROM ${RATINGS_TABLE} drt WHERE drt.driver_id = r.driver_id) AS driver_rating,
            (SELECT COUNT(*) FROM ${RATINGS_TABLE} drt2 WHERE drt2.driver_id = r.driver_id) AS driver_ratings_count,

            NULL AS vehicle_label,
            NULL AS vehicle_plate

          FROM rides r
          LEFT JOIN drivers dr ON dr.driver_id = r.driver_id
          LEFT JOIN users   u  ON u.user_id   = dr.user_id
          WHERE r.ride_id = ?
          LIMIT 1
        `,
        [request_id]
      );

      if (ride && (ride.driver_name == null || ride.driver_phone == null)) {
        const [[drvUser]] = await conn.query(
          `
            SELECT u.user_name AS driver_name, u.phone AS driver_phone
              FROM drivers dr
              JOIN users   u ON u.user_id = dr.user_id
             WHERE dr.driver_id = ?
             LIMIT 1
          `,
          [canonicalDriverId]
        );
        dbg("[jobAccept] fallback driver lookup", drvUser || null);
        if (drvUser) Object.assign(ride, drvUser);
      }

      // 3) POOL: accept all pending bookings and collect rows
      let acceptedBookings = [];
      if (ride?.trip_type === "pool") {
        await conn.execute(
          `
            UPDATE ride_bookings
               SET status = 'accepted',
                   accepted_at = NOW(),
                   driver_id = ?
             WHERE ride_id = ?
               AND status = 'requested'
          `,
          [canonicalDriverId, request_id]
        );

        const [bkRows] = await conn.query(
          `
            SELECT booking_id, passenger_id, seats, pickup_place, dropoff_place,
                   pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, fare_cents, currency
              FROM ride_bookings
             WHERE ride_id = ?
               AND status = 'accepted'
          `,
          [request_id]
        );
        acceptedBookings = bkRows || [];
      }

      await conn.commit();

      // rooms
      try {
        socket.join(driverRoom(String(canonicalDriverId)));
      } catch {}
      socket.join(rideRoom(request_id));

      const rideOut = toClientRide(ride);

      // emits to driver room(s)
      io.to(driverRoom(String(canonicalDriverId))).emit("jobAssigned", {
        ok: true,
        request_id,
        ride: rideOut,
      });
      io.to(driverRoom(String(rawDriverId))).emit("jobAssigned", {
        ok: true,
        request_id,
        ride: rideOut,
      });

      // passenger emit (container-level)
      if (ride?.passenger_id) {
        const msg = { request_id, driver_id: canonicalDriverId, ride: rideOut };
        io.to(passengerRoom(ride.passenger_id)).emit("rideAccepted", msg);
        io.to(rideRoom(request_id)).emit("rideAccepted", msg);
        console.log(
          `[emit] rideAccepted ride:${request_id} passenger:${ride.passenger_id} driver:${canonicalDriverId}`
        );
      }

      // Per-booking emits + POOL SUMMARY
      if (ride?.trip_type === "pool" && acceptedBookings.length) {
        for (const b of acceptedBookings) {
          const msg = {
            ok: true,
            request_id,
            booking_id: String(b.booking_id),
            driver_id: canonicalDriverId,
            seats: Number(b.seats),
            pickup: b.pickup_place,
            dropoff: b.dropoff_place,
            pickup_lat: b.pickup_lat,
            pickup_lng: b.pickup_lng,
            dropoff_lat: b.dropoff_lat,
            dropoff_lng: b.dropoff_lng,
            fare_cents: b.fare_cents,
            currency: b.currency,
          };
          io.to(passengerRoom(b.passenger_id)).emit("bookingAccepted", msg);
          io.to(rideRoom(request_id)).emit("bookingAccepted", msg);
        }

        try {
          const c2 = await mysqlPool.getConnection();
          await emitPoolSummary(io, c2, request_id);
          c2.release();
        } catch (e) {
          console.warn("[poolSummary emit] warn:", e?.message);
        }
      }

      // Close open offers, and notify matcher
      socket.broadcast.emit("rideClosed", { request_id });
      socket.broadcast.emit("jobRequestCancelled", { request_id });

      try {
        await matcher.acceptOffer({
          io,
          rideId: String(request_id),
          driverId: String(canonicalDriverId),
        });
      } catch (e) {
        console.warn("[matcher.acceptOffer] warn:", e?.message);
      }
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[jobAccept] error]", err);
    socket.emit("jobAssigned", { ok: false, error: "Server error" });
  }
}

async function handleJobReject({ io, socket, mysqlPool, payload }) {
  console.log("handleJobReject called with payload:", payload);
  const where = "[jobReject]";
  try {
    const { request_id, driver_id: rawDriverId } = payload || {};
    if (!request_id || !rawDriverId) {
      return socket.emit("jobRejectedAck", {
        ok: false,
        error: "Missing request_id or driver_id",
      });
    }
    if (!mysqlPool?.getConnection) {
      console.error(`${where} mysqlPool not ready`);
      return socket.emit("jobRejectedAck", {
        ok: false,
        error: "Server DB not ready",
      });
    }

    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      const canonicalDriverId = await resolveDriverId(conn, rawDriverId);
      if (!canonicalDriverId) {
        await conn.rollback();
        return socket.emit("jobRejectedAck", {
          ok: false,
          error: `Driver not found for id ${rawDriverId}`,
        });
      }

      const [res] = await conn.execute(
        `
          UPDATE rides
             SET status = 'requested',
                 offer_driver_id = NULL,
                 offer_expire_at = NULL,
                 accepted_at = NULL,
                 driver_id = NULL
           WHERE ride_id = ?
             AND status = 'offered_to_driver'
             AND (offer_driver_id IS NULL OR offer_driver_id = ?)
        `,
        [request_id, canonicalDriverId]
      );

      if (!res || res.affectedRows === 0) {
        await conn.rollback();
        return socket.emit("jobRejectedAck", {
          ok: false,
          request_id,
          error:
            "Ride not in 'offered_to_driver' or not offered to this driver",
        });
      }

      const [[row]] = await conn.query(
        `SELECT passenger_id FROM rides WHERE ride_id = ?`,
        [request_id]
      );

      await conn.commit();

      socket.emit("jobRejectedAck", { ok: true, request_id });

      if (row?.passenger_id) {
        io.to(passengerRoom(row.passenger_id)).emit("rideOfferDeclined", {
          request_id,
          by_driver_id: canonicalDriverId,
        });
      }

      io.emit("rideReopened", { request_id });

      try {
        await matcher.rejectOffer({
          io,
          rideId: String(request_id),
          driverId: String(canonicalDriverId),
        });
      } catch (e) {
        console.warn("[matcher.rejectOffer] warn:", e?.message);
      }
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[jobReject] error:", err);
    socket.emit("jobRejectedAck", { ok: false, error: "Server error" });
  }
}

async function handleDriverArrivedPickup({ io, socket, mysqlPool, payload }) {
  const { request_id } = payload || {};
  if (!request_id)
    return socket.emit("driverArrivedAck", {
      ok: false,
      error: "Missing request_id",
    });

  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();

    const [[cur]] = await conn.query(
      "SELECT status, trip_type FROM rides WHERE ride_id = ?",
      [request_id]
    );
    console.log(`[stage dbg] BEFORE ride:${request_id} status:`, cur?.status);

    const [res] = await conn.execute(
      `
        UPDATE rides
           SET status = 'arrived_pickup',
               arrived_pickup_at = NOW()
         WHERE ride_id = ?
           AND status = 'accepted'
      `,
      [request_id]
    );
    console.log(
      `[stage dbg] UPDATE ride:${request_id} affectedRows:`,
      res?.affectedRows
    );

    if (res.affectedRows === 0) {
      await conn.rollback();
      return socket.emit("driverArrivedAck", {
        ok: false,
        request_id,
        error: "Ride not in 'accepted' state",
      });
    }

    if (cur?.trip_type === "pool") {
      await conn.execute(
        `UPDATE ride_bookings
            SET status = 'arrived_pickup', arrived_pickup_at = NOW()
          WHERE ride_id = ?
            AND status IN ('requested','accepted')`,
        [request_id]
      );
    }

    await conn.commit();

    // Emit pool summary (NEW)
    if (cur?.trip_type === "pool") {
      try {
        const c2 = await mysqlPool.getConnection();
        await emitPoolSummary(io, c2, request_id);
        c2.release();
      } catch {}
    }

    let passenger_id = null;
    try {
      const c3 = await mysqlPool.getConnection();
      passenger_id = await getPassengerId(c3, request_id);
      try {
        c3.release();
      } catch {}
    } catch {}

    socket.emit("driverArrivedAck", { ok: true, request_id });

    logStage(io, request_id, "arrived_pickup", passenger_id);

    io.to(rideRoom(request_id)).emit("rideStageUpdate", {
      request_id,
      stage: "arrived_pickup",
    });
    if (cur?.trip_type === "pool") {
      io.to(rideRoom(request_id)).emit("bookingStageUpdate", {
        request_id,
        stage: "arrived_pickup",
      });
    }

    if (passenger_id) {
      io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
        request_id,
        stage: "arrived_pickup",
      });
    }
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[driverArrivedPickup] error:", err);
    socket.emit("driverArrivedAck", {
      ok: false,
      request_id,
      error: "Server error",
    });
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

async function handleDriverStartTrip({ io, socket, mysqlPool, payload }) {
  const { request_id } = payload || {};
  if (!request_id)
    return socket.emit("driverStartAck", {
      ok: false,
      error: "Missing request_id",
    });

  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();

    const [[cur]] = await conn.query(
      "SELECT status, trip_type FROM rides WHERE ride_id = ?",
      [request_id]
    );
    console.log(`[stage dbg] BEFORE ride:${request_id} status:`, cur?.status);

    const [res] = await conn.execute(
      `
        UPDATE rides
           SET status = 'started',
               started_at = NOW()
         WHERE ride_id = ?
           AND status = 'arrived_pickup'
      `,
      [request_id]
    );
    console.log(
      `[stage dbg] UPDATE ride:${request_id} affectedRows:`,
      res?.affectedRows
    );

    if (res.affectedRows === 0) {
      await conn.rollback();
      return socket.emit("driverStartAck", {
        ok: false,
        request_id,
        error: "Ride not in 'arrived_pickup' state",
      });
    }

    if (cur?.trip_type === "pool") {
      await conn.execute(
        `UPDATE ride_bookings
            SET status = 'started', started_at = NOW()
          WHERE ride_id = ?
            AND status = 'arrived_pickup'`,
        [request_id]
      );
    }

    await conn.commit();

    // Emit pool summary (NEW)
    if (cur?.trip_type === "pool") {
      try {
        const c2 = await mysqlPool.getConnection();
        await emitPoolSummary(io, c2, request_id);
        c2.release();
      } catch {}
    }

    let passenger_id = null;
    try {
      const c3 = await mysqlPool.getConnection();
      passenger_id = await getPassengerId(c3, request_id);
      try {
        c3.release();
      } catch {}
    } catch {}

    socket.emit("driverStartAck", { ok: true, request_id });

    logStage(io, request_id, "started", passenger_id);

    io.to(rideRoom(request_id)).emit("rideStageUpdate", {
      request_id,
      stage: "started",
    });
    if (cur?.trip_type === "pool") {
      io.to(rideRoom(request_id)).emit("bookingStageUpdate", {
        request_id,
        stage: "started",
      });
    }
    if (passenger_id) {
      io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
        request_id,
        stage: "started",
      });
    }
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[driverStartTrip] error:", err);
    socket.emit("driverStartAck", {
      ok: false,
      request_id,
      error: "Server error",
    });
  } finally {
    try {
      conn.release();
    } catch {}
  }
}
