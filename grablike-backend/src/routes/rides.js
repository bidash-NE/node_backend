import express from "express";
import { withConn } from "../db/mysql.js";
import { computeFareCents } from "../utils/fare.js";

export const ridesRouter = express.Router();


// Accept a ride
ridesRouter.post("/driver/ride/:id/accept", async (req, res) => {
  const { id } = req.params;
  const { driver_id } = req.body || {};
  if (!driver_id) return res.status(400).json({ message: "driver_id required" });

  try {
    const result = await withConn(async (conn) => {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM rides WHERE ride_id=? FOR UPDATE", [id]);
      const ride = rows[0];
      if (!ride) {
        await conn.rollback();
        return { status: 404, body: { message: "Ride not found" } };
      }
      const expired = ride.offer_expire_at && new Date(ride.offer_expire_at) < new Date();
      const canAccept = (ride.status === "offered_to_driver" || ride.status === "requested") &&
                        (!ride.offer_driver_id || Number(ride.offer_driver_id) === Number(driver_id)) &&
                        !expired;
      if (!canAccept && ride.status !== "accepted") {
        await conn.rollback();
        return { status: 409, body: { message: "Ride already taken or not offered to this driver" } };
      }
      if (ride.status !== "accepted") {
        await conn.query(
          "UPDATE rides SET status='accepted', accepted_at=UTC_TIMESTAMP(), driver_id=? WHERE ride_id=?",
          [driver_id, id]
        );
      }
      await conn.commit();
      return { status: 200, body: { ok: true } };
    });
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Arrived at pickup
ridesRouter.post("/driver/ride/:id/arrived", async (req, res) => {
  const { id } = req.params;
  try {
    await withConn(async (conn) => {
      await conn.query(
        "UPDATE rides SET status='arrived_pickup', arrived_pickup_at=UTC_TIMESTAMP() WHERE ride_id=? AND status IN ('accepted','arrived_pickup')",
        [id]
      );
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

// Start trip
ridesRouter.post("/driver/ride/:id/start", async (req, res) => {
  const { id } = req.params;
  try {
    await withConn(async (conn) => {
      await conn.query(
        "UPDATE rides SET status='started', started_at=UTC_TIMESTAMP() WHERE ride_id=? AND status IN ('arrived_pickup','started')",
        [id]
      );
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

// Complete trip (compute a dummy fare and upsert earnings)
ridesRouter.post("/driver/ride/:id/complete", async (req, res) => {
  const { id } = req.params;
  try {
    await withConn(async (conn) => {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM rides WHERE ride_id=? FOR UPDATE", [id]);
      const ride = rows[0];
      if (!ride) {
        await conn.rollback();
        return res.status(404).json({ message: "Ride not found" });
      }
      const cents = computeFareCents({
        distance_m: ride.distance_m || 3000,
        duration_s: ride.duration_s || 600
      });
      await conn.query(
        "UPDATE rides SET status='completed', completed_at=UTC_TIMESTAMP() WHERE ride_id=?",
        [id]
      );
      const upsert = `INSERT INTO ride_earnings
        (ride_id, base_cents, distance_cents, time_cents, surge_cents, tolls_cents, tips_cents, other_adj_cents, platform_fee_cents, tax_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          base_cents=VALUES(base_cents),
          distance_cents=VALUES(distance_cents),
          time_cents=VALUES(time_cents),
          surge_cents=VALUES(surge_cents),
          tolls_cents=VALUES(tolls_cents),
          tips_cents=VALUES(tips_cents),
          other_adj_cents=VALUES(other_adj_cents),
          platform_fee_cents=VALUES(platform_fee_cents),
          tax_cents=VALUES(tax_cents)`;
      await conn.query(upsert, [
        id,
        cents.base_cents, cents.distance_cents, cents.time_cents,
        cents.surge_cents, cents.tolls_cents, cents.tips_cents,
        cents.other_adj_cents, cents.platform_fee_cents, cents.tax_cents
      ]);
      await conn.commit();
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});



