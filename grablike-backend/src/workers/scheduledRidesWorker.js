// src/workers/scheduledRidesWorker.js
import matcher from "../matching/matcher.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scheduled rides worker (UTC-safe):
 * - Auto-releases expired reservations using UTC_TIMESTAMP()
 * - Dispatch due rides using UTC_TIMESTAMP()
 */
export function startScheduledRidesWorker({
  io,
  mysqlPool,
  pollMs = 15000,
  batchSize = 25,
}) {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      let conn;
      try {
        conn = await mysqlPool.getConnection();
        await conn.beginTransaction();

        // 1) Auto-release expired reservations (UTC safe)
        await conn.query(
          `
          UPDATE rides
          SET driver_id=NULL,
              reserved_at=NULL,
              reserved_confirmed_at=NULL,
              offer_expire_at=NULL
          WHERE booking_type='SCHEDULED'
            AND status='scheduled'
            AND driver_id IS NOT NULL
            AND offer_expire_at IS NOT NULL
            AND offer_expire_at <= UTC_TIMESTAMP()
          `
        );

        // 2) Find rides due for dispatch (UTC safe)
        const [dueRows] = await conn.query(
          `
          SELECT ride_id
          FROM rides
          WHERE booking_type='SCHEDULED'
            AND status='scheduled'
            AND scheduled_at IS NOT NULL
            AND (
              (dispatch_at IS NOT NULL AND dispatch_at <= UTC_TIMESTAMP())
              OR (dispatch_at IS NULL AND scheduled_at <= UTC_TIMESTAMP())
            )
          ORDER BY COALESCE(dispatch_at, scheduled_at) ASC
          LIMIT ?
          FOR UPDATE
          `,
          [batchSize]
        );

        if (!dueRows.length) {
          await conn.commit();
          await sleep(pollMs);
          continue;
        }

        const rideIds = dueRows.map((r) => Number(r.ride_id)).filter(Boolean);

        // 3) Claim rides: scheduled -> requested (keep driver_id as preferred if exists)
        await conn.query(
          `
          UPDATE rides
          SET status='requested',
              requested_at=UTC_TIMESTAMP()
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
            AND status='scheduled'
          `,
          rideIds
        );

        // 4) Fetch rides
        const [rides] = await conn.query(
          `
          SELECT
            ride_id,
            passenger_id,
            driver_id,
            service_type,
            pickup_place,
            dropoff_place,
            pickup_lat, pickup_lng,
            dropoff_lat, dropoff_lng,
            distance_m,
            duration_s,
            fare_cents,
            currency,
            trip_type,
            pool_batch_id
          FROM rides
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          `,
          rideIds
        );

        // 5) Fetch waypoints
        const [wps] = await conn.query(
          `
          SELECT ride_id, order_index, lat, lng, address
          FROM ride_waypoints
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          ORDER BY ride_id ASC, order_index ASC
          `,
          rideIds
        );

        await conn.commit();

        // group waypoints
        const wpByRide = new Map();
        for (const w of wps) {
          const id = String(w.ride_id);
          if (!wpByRide.has(id)) wpByRide.set(id, []);
          wpByRide.get(id).push({
            lat: Number(w.lat),
            lng: Number(w.lng),
            address: w.address || null,
          });
        }

        // 6) Dispatch to matcher
        for (const r of rides) {
          const rideId = String(r.ride_id);

          const pickup = [Number(r.pickup_lat), Number(r.pickup_lng)];
          const dropoff = [Number(r.dropoff_lat), Number(r.dropoff_lng)];

          const fare_cents =
            r.fare_cents != null && r.fare_cents !== ""
              ? Number(r.fare_cents)
              : null;

          let payment_method = null;
          try {
            if (r.payment_method) {
              payment_method =
                typeof r.payment_method === "string"
                  ? JSON.parse(r.payment_method)
                  : r.payment_method;
            }
          } catch {
            payment_method = null;
          }

          const preferred_driver_id =
            r.driver_id != null && String(r.driver_id).trim() !== ""
              ? String(r.driver_id)
              : null;

          try {
            await matcher.requestRide({
              io,
              cityId: "thimphu",
              service_code: r.service_type,
              serviceType: r.service_type,
              pickup,
              dropoff,
              pickup_place: r.pickup_place || "",
              dropoff_place: r.dropoff_place || "",
              distance_m: r.distance_m ?? 0,
              duration_s: r.duration_s ?? 0,

              fare: fare_cents != null ? fare_cents / 100 : null,
              fare_cents,

              base_fare: null,
              rideId,
              passenger_id: String(r.passenger_id),
              trip_type: r.trip_type || "instant",
              pool_batch_id: r.pool_batch_id || null,

              payment_method,
              offer_code: r.offer_code || null,

              waypoints: wpByRide.get(rideId) || [],
              seats: null,
              booking_id: null,

              job_type: "SINGLE",
              batch_id: null,

              preferred_driver_id,
            });

            console.log(
              "[scheduledWorker] dispatched:",
              rideId,
              preferred_driver_id ? `(preferred ${preferred_driver_id})` : ""
            );
          } catch (e) {
            console.error("[scheduledWorker] matcher failed:", rideId, e);
          }
        }
      } catch (e) {
        try {
          await conn?.rollback();
        } catch {}
        console.error("[scheduledWorker] error:", e);
        await sleep(pollMs);
      } finally {
        try {
          conn?.release();
        } catch {}
      }
    }
  };

  run();

  return { stop() { stopped = true; } };
}
