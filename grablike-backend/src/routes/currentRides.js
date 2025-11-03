// src/routes/currentRides.js
import express from "express";
import { getRedis } from "../matching/redis.js"; // ✅ correct path & export
import { currentRidesKey as keyFor } from "../matching/redisKeys.js"; // you already have this helper

const router = express.Router();
const redis = getRedis(); // ✅ ioredis client
const TTL = Number(process.env.RIDES_TTL_SECONDS || 0);

const sendBadReq = (res, msg) => res.status(400).json({ ok: false, error: msg });
const refreshTTL = async (key) => { if (TTL > 0) await redis.expire(key, TTL); };

/* ---------- GET all ----------
   GET /driver/current-rides?driver_id=:id
--------------------------------*/
router.get("/driver/current-rides", async (req, res) => {
  try {
    const driverId = String(req.query.driver_id || "").trim();
    if (!driverId) return sendBadReq(res, "driver_id is required");

    const key = keyFor(driverId);
    const all = await redis.hgetall(key); // { rideId: jsonString }
    const data = Object.values(all)
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("[GET current-rides] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------- GET one ----------
   GET /driver/current-rides/:rideId?driver_id=:id
--------------------------------*/
router.get("/driver/current-rides/:rideId", async (req, res) => {
  try {
    const driverId = String(req.query.driver_id || "").trim();
    const rideId   = String(req.params.rideId || "").trim();
    if (!driverId) return sendBadReq(res, "driver_id is required");
    if (!rideId)   return sendBadReq(res, "rideId is required");

    const key = keyFor(driverId);
    const raw = await redis.hget(key, rideId);
    if (!raw) return res.status(404).json({ ok: false, error: "not_found" });

    let ride = null; try { ride = JSON.parse(raw); } catch {}
    return res.json({ ok: true, data: ride });
  } catch (e) {
    console.error("[GET one current-ride] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------- UPSERT one ----------
   POST /driver/current-rides
   body: { driver_id, ride }
-----------------------------------*/
router.post("/driver/current-rides", async (req, res) => {
  try {
    const driverId = String(req.body?.driver_id || "").trim();
    const ride     = req.body?.ride;
    if (!driverId) return sendBadReq(res, "driver_id is required");
    if (!ride || typeof ride !== "object") return sendBadReq(res, "ride object is required");

    const rideId = String(ride.request_id || ride.rideId || "").trim();
    if (!rideId) return sendBadReq(res, "ride.request_id is required");

    const key = keyFor(driverId);
    await redis.hset(key, rideId, JSON.stringify(ride)); // ✅ ioredis
    await refreshTTL(key);

    return res.json({ ok: true, data: { ride_id: rideId } });
  } catch (e) {
    console.error("[POST current-rides] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------- UPSERT many ----------
   PUT /driver/current-rides/bulk
   body: { driver_id, rides: Ride[] }
------------------------------------*/
router.put("/driver/current-rides/bulk", async (req, res) => {
  try {
    const driverId = String(req.body?.driver_id || "").trim();
    const rides    = Array.isArray(req.body?.rides) ? req.body.rides : [];
    if (!driverId) return sendBadReq(res, "driver_id is required");
    if (!rides.length) return sendBadReq(res, "rides[] required");

    const key = keyFor(driverId);
    // ioredis hset supports an object: { field: value, ... }
    const obj = {};
    for (const r of rides) {
      const rid = String(r?.request_id || r?.rideId || "").trim();
      if (rid) obj[rid] = JSON.stringify(r);
    }
    if (!Object.keys(obj).length) return sendBadReq(res, "no valid rides (missing request_id)");

    await redis.hset(key, obj);
    await refreshTTL(key);

    return res.json({ ok: true, count: Object.keys(obj).length });
  } catch (e) {
    console.error("[PUT bulk current-rides] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------- DELETE one ----------
   DELETE /driver/current-rides/:rideId?driver_id=:id
------------------------------------*/
router.delete("/driver/current-rides/:rideId", async (req, res) => {
  try {
    const driverId = String(req.query.driver_id || "").trim();
    const rideId   = String(req.params.rideId || "").trim();
    if (!driverId) return sendBadReq(res, "driver_id is required");
    if (!rideId)   return sendBadReq(res, "rideId path param is required");

    const key = keyFor(driverId);
    const removed = await redis.hdel(key, rideId);
    return res.json({ ok: true, removed });
  } catch (e) {
    console.error("[DELETE one current-ride] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------- DELETE all ----------
   DELETE /driver/current-rides?driver_id=:id
------------------------------------*/
router.delete("/driver/current-rides", async (req, res) => {
  try {
    const driverId = String(req.query.driver_id || "").trim();
    if (!driverId) return sendBadReq(res, "driver_id is required");

    const key = keyFor(driverId);
    const fields = await redis.hkeys(key);
    let removed = 0;
    if (fields?.length) removed = await redis.hdel(key, ...fields);
    return res.json({ ok: true, removed });
  } catch (e) {
    console.error("[DELETE all current-rides] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;
