// src/matching/matcher.js
import * as redisMod from "./redis.js";
import { geoKey, rideHash, rideCand, rideCurrent, rideRejected } from "./redisKeys.js";
import { presence } from "./presence.js";

const getRedis =
  redisMod.getRedis ?? (redisMod.default && redisMod.default.getRedis);
if (!getRedis) throw new Error("matching/redis.js must export getRedis");

const redis = getRedis();

// ----- pluggable offer adapter -----
let offerAdapter = {
  setOffer: async () => {},
  clearOffer: async () => {},
  reopenRequested: async () => {},
  markNoDrivers: async () => {},
  finalizeOnAccept: async () => {},
};
export function configureMatcher(adapter) {
  offerAdapter = { ...offerAdapter, ...adapter };
}

// ----- discover candidates -----
// NOTE: our geo keys historically use (cityId, serviceType). We pass the
// service_code in as serviceType to keep geoKey format unchanged.
async function discoverCandidates({
  cityId,
  serviceType, // can be service_code
  pickup,
  steps = [5000, 10000, 20000, 30000, 50000],
  count = 25,
}) {
  const [lat, lng] = pickup;
  for (const r of steps) {
    try {
      let res = [];
      try {
        // Newer Redis versions
        res = await redis.geosearch(
          geoKey(cityId, serviceType),
          "FROMLONLAT",
          Number(lng),
          Number(lat),
          "BYRADIUS",
          r,
          "m",
          "ASC",
          "COUNT",
          count,
          "WITHCOORD"
        );
      } catch (e) {
        // Legacy Redis fallback
        console.warn(
          "[discoverCandidates] geosearch failed, fallback to georadius",
          e.message
        );
        const legacy = await redis.georadius(
          geoKey(cityId, serviceType),
          Number(lng),
          Number(lat),
          r,
          "m",
          "WITHCOORD",
          "ASC",
          "COUNT",
          count
        );
        res = legacy;
      }

      if (res.length > 0) {
        console.log(`[discoverCandidates] radius=${r}m found=${res.length}`);
        return res.map(([id]) => id);
      }
    } catch (e) {
      console.error("[discoverCandidates] error:", e);
    }
  }
  console.log(
    "[discoverCandidates] No drivers found for pickup=",
    pickup
  );
  return [];
}

// ----- offerNext -----
async function offerNext(io, rideId, ttlSec = 15) {
  const state = await redis.hget(rideHash(rideId), "state");
  if (state !== "searching") return;

  const cur = await redis.get(rideCurrent(rideId));
  if (cur) return;

  const nextDriver = await redis.lpop(rideCand(rideId));
  if (!nextDriver) {
    await redis.hset(rideHash(rideId), { state: "no_drivers" });
    io.to(`ride:${rideId}`).emit("ride:status", { state: "no_drivers" });
    await offerAdapter.markNoDrivers({ rideId });
    return;
  }

  await redis.set(rideCurrent(rideId), nextDriver, "EX", ttlSec);

  const expireAt = new Date(Date.now() + ttlSec * 1000);
  try {
    await offerAdapter.setOffer({ rideId, driverId: nextDriver, expireAt });
  } catch (e) {
    console.warn("[matcher.setOffer] DB write failed:", e.message);
  }

  const ride = await redis.hgetall(rideHash(rideId));

  // Normalize fare to units for emission
  let fareOut;
  if (ride.fare != null && ride.fare !== "") {
    const n = Number(ride.fare);
    if (Number.isFinite(n)) fareOut = n;
  } else if (ride.fare_cents != null && ride.fare_cents !== "") {
    const c = Number(ride.fare_cents);
    if (Number.isFinite(c)) fareOut = c / 100;
  } else if (ride.base_fare != null && ride.base_fare !== "") {
    // ultimate fallback
    const b = Number(ride.base_fare);
    if (Number.isFinite(b)) fareOut = b;
  }

  // Convert stored strings back to proper shapes
  const pickupArr = ride.pickup ? JSON.parse(ride.pickup) : undefined;
  const dropoffArr = ride.dropoff ? JSON.parse(ride.dropoff) : undefined;

  io.to(`driver:${nextDriver}`).emit("jobRequest", {
    request_id: rideId,
    passenger_id: ride.passenger_id,

    pickup: pickupArr,
    dropoff: dropoffArr,
    pickup_place: ride.pickup_place || "",
    dropoff_place: ride.dropoff_place || "",

    // driver-facing summary
    distance_m: Number(ride.distance_m || 0),
    distance_km: Math.round((Number(ride.distance_m || 0) / 1000) * 10) / 10,
    eta_min: Math.round(Number(ride.duration_s || 0) / 60),

    // ✅ emit the real fare now
    fare: fareOut ?? 0,

    // meta
    cityId: ride.cityId,
    serviceType: ride.serviceType,
    service_code: ride.service_code,
    trip_type: ride.trip_type || "instant",
    offer_code: ride.offer_code || null,
    payment_method: ride.payment_method
      ? JSON.parse(ride.payment_method)
      : null,
  });

  setTimeout(async () => {
    const still = await redis.get(rideCurrent(rideId));
    const st = await redis.hget(rideHash(rideId), "state");
    if (st === "searching" && still === nextDriver) {
      await redis.sadd(rideRejected(rideId), nextDriver);
      await redis.del(rideCurrent(rideId));
      await offerAdapter.reopenRequested({ rideId });
      io.to(`driver:${nextDriver}`).emit("jobRequestCancelled", {
        request_id: rideId,
        reason: "timeout",
      });
      offerNext(io, rideId, ttlSec);
    }
  }, ttlSec * 1000);
}

// ----- matcher object -----
export const matcher = {
  // ✅ Accept fare / fare_cents from caller and store as-is (no computation)
  async requestRide({
    io,
    cityId,
    service_code,                 // canonical code for geo
    serviceType,                  // label for UI
    pickup,
    dropoff,
    pickup_place,
    dropoff_place,
    distance_m,
    duration_s,
    fare,                         // units
    fare_cents,                   // integer cents (preferred)
    base_fare,                    // legacy
    rideId,
    passenger_id,
    trip_type,
    pool_batch_id,
    payment_method,
    offer_code,
  }) {
    await redis.hset(rideHash(rideId), {
      state: "searching",

      cityId: cityId || "thimphu",

      // keep both: label + canonical code
      serviceType: serviceType || service_code,
      service_code: service_code || serviceType,

      // store points as JSON strings
      pickup: JSON.stringify(pickup),
      dropoff: JSON.stringify(dropoff),
      pickup_place: pickup_place || "",
      dropoff_place: dropoff_place || "",

      distance_m: Number.isFinite(Number(distance_m)) ? Number(distance_m) : 0,
      duration_s: Number.isFinite(Number(duration_s)) ? Number(duration_s) : 0,

      // ✅ store exactly what we received
      fare: fare != null ? String(fare) : "",
      fare_cents: fare_cents != null ? String(fare_cents) : "",
      base_fare: base_fare != null ? String(base_fare) : "",

      passenger_id: passenger_id || "",
      trip_type: trip_type || "instant",
      pool_batch_id: pool_batch_id || "",

      payment_method: payment_method ? JSON.stringify(payment_method) : "",
      offer_code: offer_code ?? "",
    });

    // For discovery we use the canonical service_code as the geo key "serviceType"
    const candidates = await discoverCandidates({
      cityId,
      serviceType: service_code || serviceType,
      pickup,
    });

    if (!candidates.length) {
      await redis.hset(rideHash(rideId), { state: "no_drivers" });
      await offerAdapter.markNoDrivers({ rideId });
      console.log(
        `[matcher.requestRide] rideId=${rideId} no drivers found, cancelling`
      );
      return { rideId, state: "no_drivers" };
    }

    const pipe = redis.multi();
    candidates.forEach((id) => pipe.rpush(rideCand(rideId), id));
    await pipe.exec();

    await offerNext(io, rideId);
    return {
      rideId,
      state: "searching",
      candidates: candidates.length,
      pickup,
      dropoff,
      pickup_place,
      dropoff_place,
      distance_m,
      duration_s,
      fare,
    };
  },

  async acceptOffer({ io, rideId, driverId }) {
    const cur = await redis.get(rideCurrent(rideId));
    if (cur !== driverId) return { ok: false, reason: "not_current" };
    await redis.hset(rideHash(rideId), { state: "assigned", driver: driverId });
    await redis.del(rideCurrent(rideId));
    await offerAdapter.finalizeOnAccept({ rideId });

    io.to(`ride:${rideId}`).emit("match:found", { driverId });
    io.to(`driver:${driverId}`).emit("offer:confirmed", { request_id: rideId });
    return { ok: true };
  },

  async rejectOffer({ io, rideId, driverId }) {
    await redis.sadd(rideRejected(rideId), driverId);
    const cur = await redis.get(rideCurrent(rideId));
    if (cur === driverId) await redis.del(rideCurrent(rideId));
    await offerAdapter.reopenRequested({ rideId });

    io.to(`driver:${driverId}`).emit("jobRequestCancelled", {
      request_id: rideId,
      reason: "reject",
    });
    await offerNext(io, rideId);
    return { ok: true };
  },

  discoverCandidates,
};

export default matcher;
