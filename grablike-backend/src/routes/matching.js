// src/routes/matching.js (ESM)
import express from "express";
import matcher from "../matching/matcher.js";
import { driverHash } from "../matching/redisKeys.js";
import { getRedis } from "../matching/redis.js";
import { applyCancellationPolicy } from "../services/cancellations.js";

export function makeMatchingRouter(io, mysqlPool) {
  const router = express.Router();

  // ------------------------ POST /request ------------------------
router.post("/request", async (req, res) => {
  try { console.log("[/rides/match/request] req.body:", JSON.stringify(req.body, null, 2)); } catch {}

  const {
    passenger_id,
    cityId = "thimphu",
    serviceType,
    service_code,
    pickup,
    dropoff,
    pickup_place,
    dropoff_place,
    distance_m,
    duration_s,
    base_fare,
    fare: fareRaw,
    fare_cents: fareCentsRaw,
    trip_type: tripTypeRaw = "instant",
    pool_batch_id: poolBatchRaw = null,  // may be numeric from client
    currency: currencyRaw = "BTN",
    payment_method = null,
    offer_code = null,
    seats: seatsRaw = 1,                 // only for pool
  } = req.body || {};

  // ---- Basic validation
  if (!passenger_id) return res.status(400).json({ error: "passenger_id is required" });
  if (!Array.isArray(pickup) || pickup.length !== 2 || isNaN(pickup[0]) || isNaN(pickup[1]))
    return res.status(400).json({ error: "pickup must be [lat, lng]" });
  if (!Array.isArray(dropoff) || dropoff.length !== 2 || isNaN(dropoff[0]) || isNaN(dropoff[1]))
    return res.status(400).json({ error: "dropoff must be [lat, lng]" });
  if (!service_code || String(service_code).trim().length === 0)
    return res.status(400).json({ error: "service_code is required" });

  // ---- Normalize trip
  const trip_type = String(tripTypeRaw).toLowerCase() === "pool" ? "pool" : "instant";

  // ---- Normalize numbers
  const distInt = Number.isFinite(Number(distance_m)) ? Math.max(0, Math.trunc(Number(distance_m))) : null;
  const durInt  = Number.isFinite(Number(duration_s)) ? Math.max(0, Math.trunc(Number(duration_s))) : null;
  const currency = (currencyRaw || "BTN").toString().slice(0, 8).toUpperCase();

  // fare passthrough
  const fareUnits = Number.isFinite(Number(fareRaw))
    ? Number(fareRaw)
    : Number.isFinite(Number(base_fare))
    ? Number(base_fare)
    : null;

  const fareCents = Number.isFinite(Number(fareCentsRaw))
    ? Number(fareCentsRaw)
    : fareUnits != null
    ? Math.round(fareUnits * 100)
    : null;

  const seats = Number.isFinite(Number(seatsRaw)) ? Math.max(1, Math.trunc(Number(seatsRaw))) : 1;

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    // ✅ Prepare pool_batch_id for pool trips (BIGINT), otherwise NULL.
    //    - If client provided a numeric id, use it.
    //    - Else create a pool_batches row and use insertId.
    let pool_batch_id = null;
    if (trip_type === "pool") {
      const numericProvided = Number(poolBatchRaw);
      if (Number.isFinite(numericProvided) && numericProvided > 0) {
        pool_batch_id = numericProvided;
      } else {
        const [pbIns] = await conn.execute(
          `INSERT INTO pool_batches (city_id, service_type, status, created_at)
           VALUES (?, ?, 'forming', NOW())`,
          [cityId, serviceType || service_code]
        );
        pool_batch_id = Number(pbIns.insertId);
      }
    }

    // Insert ride shell
    const [ins] = await conn.execute(
      `
      INSERT INTO rides (
        passenger_id, service_type, status, requested_at,
        pickup_place, dropoff_place,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        distance_m, duration_s, currency,
        trip_type, pool_batch_id,
        fare_cents
      ) VALUES (?, ?, 'requested', NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        passenger_id,
        (serviceType || service_code),
        pickup_place ?? null,
        dropoff_place ?? null,
        Number(pickup[0]),
        Number(pickup[1]),
        Number(dropoff[0]),
        Number(dropoff[1]),
        distInt,
        durInt,
        currency,
        trip_type,
        pool_batch_id,  // <-- BIGINT or NULL (no UUID strings)
        fareCents,
      ]
    );

    const rideId = String(ins.insertId);
    let bookingId = null;

    // If pool: insert a booking row for THIS passenger’s seat(s)
    if (trip_type === "pool") {
      const [insBk] = await conn.execute(
        `
        INSERT INTO ride_bookings (
          ride_id, passenger_id, seats, status, requested_at,
          pickup_place, dropoff_place, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          fare_cents, currency
        )
        VALUES (?, ?, ?, 'requested', NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          rideId,
          passenger_id,
          seats,
          pickup_place ?? null,
          dropoff_place ?? null,
          Number(pickup[0]), Number(pickup[1]),
          Number(dropoff[0]), Number(dropoff[1]),
          fareCents ?? 0,
          currency,
        ]
      );
      bookingId = String(insBk.insertId);
    }

    await conn.commit();

    // Kick off matcher with everything it needs
    await matcher.requestRide({
      io,
      cityId,
      service_code,
      serviceType: serviceType || service_code,
      pickup,
      dropoff,
      pickup_place,
      dropoff_place,
      distance_m: distInt,
      duration_s: durInt,
      fare: fareUnits,
      fare_cents: fareCents,
      base_fare,
      rideId,
      passenger_id: String(passenger_id),
      trip_type,
      pool_batch_id,   // numeric or null
      booking_id: bookingId || null,
      seats,
      payment_method,
      offer_code,
    });

    return res.json({ ok: true, rideId, bookingId, trip_type, pool_batch_id });
  } catch (e) {
    try { await conn?.rollback(); } catch {}
    console.error("[/rides/match/request] error:", e);
    return res.status(500).json({ error: "Server error" });
  } finally {
    try { conn?.release(); } catch {}
  }
});


  // ------------------------ POST /cancel (whole ride) ------------------------
  // { rideId, by: 'passenger'|'driver'|'system', reason? }
  router.post("/cancel", async (req, res) => {
    const { rideId, by = "passenger", reason = "" } = req.body || {};
    if (!rideId) return res.status(400).json({ error: "rideId required" });

    let conn;
    try {
      conn = await mysqlPool.getConnection();
      await conn.beginTransaction();

      const [[cur]] = await conn.query(`SELECT * FROM rides WHERE ride_id = ? FOR UPDATE`, [rideId]);
      if (!cur) {
        await conn.rollback();
        return res.status(404).json({ error: "Ride not found" });
      }

      if (["completed","cancelled_driver","cancelled_rider","cancelled_system"].includes(cur.status)) {
        await conn.rollback();
        return res.status(400).json({ error: "Ride already finished" });
      }

      const cancelledStatus =
        by === "driver" ? "cancelled_driver" :
        by === "system" ? "cancelled_system" : "cancelled_rider";

      const lastStage =
        cur.status === "arrived_pickup" ? "arrived_pickup" :
        cur.status === "accepted" ? "accepted" : null;

      await conn.execute(
        `UPDATE rides SET status=?, cancelled_at=NOW(), cancel_reason=? WHERE ride_id=?`,
        [cancelledStatus, reason, rideId]
      );

      let policy = { applied: false };
      if (by === "passenger" && (lastStage === "accepted" || lastStage === "arrived_pickup")) {
        policy = await applyCancellationPolicy({ conn, rideId }); // ride-level
      }

      await conn.commit();

      const payload = {
        ok: true,
        rideId: String(rideId),
        cancelled_by: by,
        status: cancelledStatus,
        reason,
        policy,
      };

      io.to(`ride:${rideId}`).emit("rideCancelled", payload);
      io.to(`ride:${rideId}`).emit("ride:status", { state: "cancelled", ...payload });

      try {
        const redis = getRedis();
        const { rideHash } = await import("../matching/redisKeys.js");
        await redis.hset(rideHash(rideId), { state: "cancelled" });
      } catch (e) {
        console.warn("[/rides/match/cancel] redis sync warn:", e?.message);
      }

      return res.json({ ok: true, ...payload });
    } catch (e) {
      try { await conn?.rollback(); } catch {}
      console.error("[/rides/match/cancel] error:", e);
      return res.status(500).json({ error: "Server error" });
    } finally {
      try { conn?.release(); } catch {}
    }
  });

  // ------------------------ POST /cancel-booking (pool seat) ------------------------
  // { rideId, bookingId, by: 'passenger'|'system', reason? }
  router.post("/cancel-booking", async (req, res) => {
    const { rideId, bookingId, by = "passenger", reason = "" } = req.body || {};
    if (!rideId || !bookingId) return res.status(400).json({ error: "rideId and bookingId required" });

    let conn;
    try {
      conn = await mysqlPool.getConnection();
      await conn.beginTransaction();

      const [[bk]] = await conn.query(
        `SELECT rb.*, r.status AS ride_status
           FROM ride_bookings rb
           JOIN rides r ON r.ride_id = rb.ride_id
          WHERE rb.booking_id = ? AND rb.ride_id = ?
          FOR UPDATE`,
        [bookingId, rideId]
      );
      if (!bk) {
        await conn.rollback();
        return res.status(404).json({ error: "Booking not found" });
      }

      if (["cancelled_passenger","cancelled_system","cancelled_driver","completed","dropped"].includes(bk.status)) {
        await conn.rollback();
        return res.status(400).json({ error: "Booking already finished" });
      }

      const eligibleLateStage = (bk.ride_status === "accepted" || bk.ride_status === "arrived_pickup");

      await conn.execute(
        `UPDATE ride_bookings
            SET status = ?, cancelled_at = NOW(), cancel_reason = ?
          WHERE booking_id = ?`,
        [by === "passenger" ? "cancelled_passenger" : "cancelled_system", reason, bookingId]
      );

      let policy = { applied: false };
      if (by === "passenger" && eligibleLateStage) {
        policy = await applyCancellationPolicy({ conn, rideId, bookingId });
      }

      // Optional: if this was the last active booking you may cancel/close the container ride.

      await conn.commit();

      const payload = {
        ok: true,
        rideId: String(rideId),
        bookingId: String(bookingId),
        cancelled_by: by,
        reason,
        policy,
      };

      io.to(`ride:${rideId}`).emit("bookingCancelled", payload);
      return res.json(payload);
    } catch (e) {
      try { await conn?.rollback(); } catch {}
      console.error("[/rides/match/cancel-booking] error:", e);
      return res.status(500).json({ error: "Server error" });
    } finally {
      try { conn?.release(); } catch {}
    }
  });

  // ------------------------ GET /nearbyDrivers (legacy helper) ------------------------
  router.get("/nearbyDrivers", async (req, res) => {
    const { serviceType = "bike", lat, lng, radiusM, count } = req.query;
    if ([lat, lng].some((v) => typeof v === "undefined" || isNaN(Number(v)))) {
      return res.status(400).json({ error: "lat and lng are required and must be numbers" });
    }

    try {
      const drivers = await matcher.discoverCandidates({
        cityId: "thimphu",
        serviceType,
        pickup: [Number(lat), Number(lng)],
        steps: radiusM ? [Number(radiusM)] : undefined,
        count: count ? Number(count) : undefined,
      });

      const redis = getRedis();
      const driverDetails = await Promise.all(
        drivers.map(async (driverId) => {
          const details = await redis.hgetall(driverHash(driverId));
          return { driverId, ...details };
        })
      );

      return res.json({ drivers: driverDetails });
    } catch (e) {
      console.error("[/rides/match/nearbyDrivers] error:", e);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
}

export default makeMatchingRouter;
