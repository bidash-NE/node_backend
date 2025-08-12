const Joi = require("joi");
const db = require("../config/db");
const redis = require("../config/redis");
const rideRequestModel = require("../models/rideRequestModel");
const Driver = require("../models/driverModel");

exports.requestRide = async (req, res) => {
  const io = req.app.locals?.io;

  /* ========================= Robust Redis Helpers ========================= */

  // 7 days TTL
  const ONE_WEEK = 7 * 24 * 60 * 60; // 604800

  const roundCoord = (n, p = 6) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    const f = 10 ** p;
    return Math.round(x * f) / f;
  };

  // Safe JSON.parse
  const safeParseJSON = (str) => {
    try {
      if (str == null) return null;
      const s = String(str).trim();
      if (!s || s === "null" || s === "undefined") return null;
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // Safe: GET JSON → object|array|null
  const redisGetJSON = async (key) => {
    try {
      const val = await redis.get(key);
      return safeParseJSON(val);
    } catch {
      return null;
    }
  };

  // Safe: SET JSON with expiry
  const redisSetJSON = async (key, obj, ttlSec = ONE_WEEK) => {
    try {
      const payload = JSON.stringify(obj ?? null);
      // ioredis: set key value 'EX' ttl
      if (typeof redis.set === "function") {
        await redis.set(key, payload, "EX", ttlSec);
      }
    } catch {
      /* ignore */
    }
  };

  // Safe TTL
  const ensureTTL = async (key, seconds = ONE_WEEK) => {
    try {
      const ttl = await redis.ttl(key);
      if (ttl === -1 || ttl === -2) {
        await redis.expire(key, seconds);
      }
    } catch {
      /* ignore */
    }
  };

  // Safe ZINCRBY
  const zIncrBySafe = async (key, increment, member) => {
    try {
      if (!key || member == null) return;
      await redis.zincrby(key, Number(increment) || 1, String(member));
    } catch {
      /* ignore */
    }
  };

  // Safe GEOADD for both ioredis (geoadd) and node-redis v4 (geoAdd)
  const geoAddSafe = async (key, lng, lat, member) => {
    try {
      const L = roundCoord(lng);
      const A = roundCoord(lat);
      const M = String(member);

      if (typeof redis.geoadd === "function") {
        // ioredis signature: geoadd(key, lon, lat, member)
        await redis.geoadd(key, L, A, M);
        return;
      }
      if (typeof redis.geoAdd === "function") {
        // node-redis v4 signature: geoAdd(key, [{ longitude, latitude, member }])
        await redis.geoAdd(key, [{ longitude: L, latitude: A, member: M }]);
        return;
      }
      // Fallback: raw command
      if (typeof redis.sendCommand === "function") {
        await redis.sendCommand(["GEOADD", key, String(L), String(A), M]);
      }
    } catch {
      /* ignore */
    }
  };

  /* ============================== Handler =============================== */

  try {
    console.log("▶️ Incoming ride request payload");

    // Validate input
    const schema = Joi.object({
      rider_id: Joi.number().required(),
      pickup_lat: Joi.number().required(),
      pickup_lng: Joi.number().required(),
      dropoff_lat: Joi.number().required(),
      dropoff_lng: Joi.number().required(),
      pickup_address: Joi.string().required(),
      dropoff_address: Joi.string().required(),
      ride_type: Joi.string().required(),
      payment_method: Joi.string().valid("cash", "card", "grabpay").required(),
      distance_meters: Joi.number().required(),
      duration_seconds: Joi.number().required(),
      no_of_passenger: Joi.number().min(1).required(),
      socketId: Joi.string().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      console.log("❌ Validation error:", error.details?.[0]?.message);
      return res.status(400).json({ error: error.details?.[0]?.message });
    }

    const {
      rider_id,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      pickup_address,
      dropoff_address,
      ride_type,
      payment_method,
      distance_meters,
      duration_seconds,
      no_of_passenger,
      socketId,
    } = value;

    /* --------- Ride types: redis cache with robust JSON handling --------- */

    let rideTypes = [];
    try {
      const cached = await redisGetJSON("ride_types");
      if (Array.isArray(cached) && cached.length > 0) {
        rideTypes = cached;
      } else {
        const [rows] = await db.query("SELECT * FROM ride_types");
        rideTypes = Array.isArray(rows) ? rows : [];
        // cache for 1 hour; data shape is stable
        await redisSetJSON("ride_types", rideTypes, 3600);
      }
    } catch (e) {
      console.log("⚠️ ride_types cache bypass due to:", e?.message || e);
      const [rows] = await db.query("SELECT * FROM ride_types");
      rideTypes = Array.isArray(rows) ? rows : [];
    }

    const rideType = rideTypes.find((t) => t?.name === ride_type);
    if (!rideType) {
      return res.status(400).json({ error: "Invalid ride type selected" });
    }

    /* ------------------------------ Fare ------------------------------- */

    const fare_estimate =
      Number(rideType.base_fare || 0) +
      Math.round(
        (Number(distance_meters) / 1000) * Number(rideType.per_km || 0)
      ) +
      Math.round(
        (Number(duration_seconds) / 60) * Number(rideType.per_min || 0)
      );

    /* --------------------------- Persist ride -------------------------- */

    const ride_request_id = await rideRequestModel.createRideRequest({
      rider_id,
      ride_type_id: rideType.ride_type_id,
      fare_estimate,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      pickup_address,
      dropoff_address,
      no_of_passenger,
    });

    await rideRequestModel.createPayment({
      ride_request_id,
      amount_cents: fare_estimate,
      method: payment_method,
    });

    /* --------- Popular locations (global + per-user) with 1-week TTL -------- */

    try {
      const globalPickupKey = "popular:pickup_locations";
      const globalDropoffKey = "popular:dropoff_locations";
      const userPickupKey = `user:${rider_id}:popular:pickup`;
      const userDropoffKey = `user:${rider_id}:popular:dropoff`;
      const geoPickupKey = "geo:popular:pickup";
      const geoDropoffKey = "geo:popular:dropoff";

      // PICKUP
      if (pickup_address) {
        const pickupMemberJSON = JSON.stringify({
          address: pickup_address,
          lat: roundCoord(pickup_lat),
          lng: roundCoord(pickup_lng),
        });

        await zIncrBySafe(globalPickupKey, 1, pickup_address); // simple global trend by address
        await zIncrBySafe(userPickupKey, 1, pickupMemberJSON); // per-user detail (lat/lng)

        await geoAddSafe(
          geoPickupKey,
          pickup_lng,
          pickup_lat,
          pickup_address // use address as member id; you can switch to an ID if needed
        );

        await ensureTTL(globalPickupKey, ONE_WEEK);
        await ensureTTL(userPickupKey, ONE_WEEK);
        await ensureTTL(geoPickupKey, ONE_WEEK);
      }

      // DROPOFF
      if (dropoff_address) {
        const dropoffMemberJSON = JSON.stringify({
          address: dropoff_address,
          lat: roundCoord(dropoff_lat),
          lng: roundCoord(dropoff_lng),
        });

        await zIncrBySafe(globalDropoffKey, 1, dropoff_address);
        await zIncrBySafe(userDropoffKey, 1, dropoffMemberJSON);

        await geoAddSafe(
          geoDropoffKey,
          dropoff_lng,
          dropoff_lat,
          dropoff_address
        );

        await ensureTTL(globalDropoffKey, ONE_WEEK);
        await ensureTTL(userDropoffKey, ONE_WEEK);
        await ensureTTL(geoDropoffKey, ONE_WEEK);
      }
    } catch (e) {
      console.warn("⚠️ Popular location tracking error:", e?.message || e);
    }

    /* ----------------------- Device ID (best-effort) ---------------------- */

    let device_id = null;
    try {
      const [rows] = await db.query(
        "SELECT device_id FROM user_devices WHERE user_id = ? LIMIT 1",
        [rider_id]
      );
      device_id = rows?.[0]?.device_id ?? null;
    } catch (e) {
      console.warn("⚠️ Device ID fetch error:", e?.message || e);
    }

    /* -------------------- Nearest drivers (MongoDB) ---------------------- */

    const maxRadius = 5000;
    let radius = 1000;
    let nearestDrivers = [];
    try {
      while (radius <= maxRadius && nearestDrivers.length === 0) {
        nearestDrivers = await Driver.find({
          is_online: true,
          available_capacity: { $gte: no_of_passenger },
          vehicle_type: ride_type,
          current_location: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [Number(pickup_lng), Number(pickup_lat)],
              },
              $maxDistance: radius,
            },
          },
        })
          .select("user_id name phone current_location device_id")
          .lean();

        radius += 1000;
      }
    } catch (e) {
      console.error("⚠️ Mongo geo query failed:", e?.message || e);
      nearestDrivers = [];
    }

    /* ---------------------------- Socket room ---------------------------- */

    try {
      const rideRoom = `ride_${ride_request_id}`;
      const sock = socketId && io?.sockets?.sockets?.get(socketId);
      if (sock && typeof sock.join === "function") {
        await sock.join(rideRoom);
      }
    } catch (e) {
      console.warn("⚠️ Socket join error:", e?.message || e);
    }

    /* ------------------------------ Reply ------------------------------- */

    const payloadBase = {
      request_id: ride_request_id,
      fare_estimate,
    };

    if (!nearestDrivers || nearestDrivers.length === 0) {
      // Diagnostics
      try {
        const nearby = await Driver.find({
          current_location: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [Number(pickup_lng), Number(pickup_lat)],
              },
              $maxDistance: maxRadius,
            },
          },
        })
          .select("is_online available_capacity vehicle_type")
          .lean();

        if (!nearby || nearby.length === 0) {
          return res.status(404).json({
            ...payloadBase,
            message: "❌ No drivers nearby within 5km radius.",
          });
        }

        const online = nearby.filter((d) => d.is_online);
        if (online.length === 0) {
          return res.status(404).json({
            ...payloadBase,
            message: "🚫 No drivers online nearby.",
          });
        }

        const capacityMatch = online.filter(
          (d) => Number(d.available_capacity) >= Number(no_of_passenger)
        );
        if (capacityMatch.length === 0) {
          return res.status(404).json({
            ...payloadBase,
            message: "🚫 No online drivers with enough capacity.",
          });
        }

        const rideTypeMatch = capacityMatch.filter(
          (d) => d.vehicle_type === ride_type
        );
        if (rideTypeMatch.length === 0) {
          return res.status(404).json({
            ...payloadBase,
            message: `🚫 No online drivers with vehicle type "${ride_type}".`,
          });
        }
      } catch {
        // If diagnostics fail, still return generic message
      }

      return res.status(404).json({
        ...payloadBase,
        message: "🚫 No matching driver found.",
      });
    }

    const driversList = nearestDrivers.map((d) => ({
      user_id: d.user_id,
      name: d.name,
      phone: d.phone,
      location: d.current_location,
      device_id: d.device_id,
    }));

    const driverPayload = {
      ...payloadBase,
      message: `✅ Ride request created and found ${driversList.length} matching drivers nearby`,
      nearest_drivers: driversList,
    };

    try {
      io?.emit?.("ride_request_broadcast", {
        response: driverPayload,
        request: req.body,
        device_id,
      });
    } catch {
      /* ignore */
    }

    return res.status(201).json(driverPayload);
  } catch (err) {
    console.error(
      "🔥 Error in ride request:",
      err?.stack || err?.message || err
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};

// exports.requestRide = async (req, res) => {
//   const io = req.app.locals.io;

//   try {
//     console.log("▶️ Incoming ride request payload");

//     // Validate input
//     const schema = Joi.object({
//       rider_id: Joi.number().required(),
//       pickup_lat: Joi.number().required(),
//       pickup_lng: Joi.number().required(),
//       dropoff_lat: Joi.number().required(),
//       dropoff_lng: Joi.number().required(),
//       pickup_address: Joi.string().required(),
//       dropoff_address: Joi.string().required(),
//       ride_type: Joi.string().required(),
//       payment_method: Joi.string().valid("cash", "card", "grabpay").required(),
//       distance_meters: Joi.number().required(),
//       duration_seconds: Joi.number().required(),
//       no_of_passenger: Joi.number().min(1).required(),
//       socketId: Joi.string().optional(),
//     });

//     const { error, value } = schema.validate(req.body);
//     if (error) {
//       console.log("❌ Validation error:", error.details[0].message);
//       return res.status(400).json({ error: error.details[0].message });
//     }

//     const {
//       rider_id,
//       pickup_lat,
//       pickup_lng,
//       dropoff_lat,
//       dropoff_lng,
//       pickup_address,
//       dropoff_address,
//       ride_type,
//       payment_method,
//       distance_meters,
//       duration_seconds,
//       no_of_passenger,
//       socketId,
//     } = value;

//     // Get or cache ride types
//     let rideTypes = [];
//     try {
//       const cachedRideTypes = await redis.get("ride_types");
//       if (cachedRideTypes) {
//         rideTypes = JSON.parse(cachedRideTypes);
//       } else {
//         const [rows] = await db.query("SELECT * FROM ride_types");
//         rideTypes = rows;
//         await redis.set("ride_types", JSON.stringify(rows), "EX", 3600);
//       }
//     } catch (err) {
//       console.error("❌ Redis error:", err.message);
//       const [rows] = await db.query("SELECT * FROM ride_types");
//       rideTypes = rows;
//     }

//     const rideType = rideTypes.find((type) => type.name === ride_type);
//     if (!rideType) {
//       return res.status(400).json({ error: "Invalid ride type selected" });
//     }

//     // Calculate fare
//     const fare_estimate =
//       rideType.base_fare +
//       Math.round((distance_meters / 1000) * rideType.per_km) +
//       Math.round((duration_seconds / 60) * rideType.per_min);

//     // Save ride request
//     const ride_request_id = await rideRequestModel.createRideRequest({
//       rider_id,
//       ride_type_id: rideType.ride_type_id,
//       fare_estimate,
//       pickup_lat,
//       pickup_lng,
//       dropoff_lat,
//       dropoff_lng,
//       pickup_address,
//       dropoff_address,
//       no_of_passenger,
//     });

//     // Create payment record
//     await rideRequestModel.createPayment({
//       ride_request_id,
//       amount_cents: fare_estimate,
//       method: payment_method,
//     });

//     // Update Redis popular locations
//     try {
//       if (dropoff_address) {
//         await redis.zincrby("popular:dropoff_locations", 1, dropoff_address);
//         if ((await redis.ttl("popular:dropoff_locations")) === -1) {
//           await redis.expire("popular:dropoff_locations", 86400);
//         }
//       }

//       if (pickup_address) {
//         await redis.zincrby("popular:pickup_locations", 1, pickup_address);
//         if ((await redis.ttl("popular:pickup_locations")) === -1) {
//           await redis.expire("popular:pickup_locations", 86400);
//         }
//       }
//     } catch (err) {
//       console.warn("⚠️ Redis location tracking error:", err.message);
//     }

//     // Get rider's device ID
//     let device_id = null;
//     try {
//       const [rows] = await db.query(
//         "SELECT device_id FROM user_devices WHERE user_id = ?",
//         [rider_id]
//       );
//       if (rows.length > 0) device_id = rows[0].device_id;
//     } catch (err) {
//       console.warn("⚠️ Device ID fetch error:", err.message);
//     }

//     // Find nearest drivers (MongoDB)
//     const maxRadius = 5000;
//     let radius = 1000;
//     let nearestDrivers = [];
//     while (radius <= maxRadius && nearestDrivers.length === 0) {
//       nearestDrivers = await Driver.find({
//         is_online: true,
//         available_capacity: { $gte: no_of_passenger },
//         vehicle_type: ride_type,
//         current_location: {
//           $nearSphere: {
//             $geometry: {
//               type: "Point",
//               coordinates: [pickup_lng, pickup_lat],
//             },
//             $maxDistance: radius,
//           },
//         },
//       }).lean();

//       radius += 1000;
//     }

//     const rideRoom = `ride_${ride_request_id}`;
//     if (socketId && io.sockets.sockets.get(socketId)) {
//       io.sockets.sockets.get(socketId).join(rideRoom);
//     }

//     const payloadBase = {
//       request_id: ride_request_id,
//       fare_estimate,
//     };

//     if (!nearestDrivers || nearestDrivers.length === 0) {
//       // Perform analysis to explain why
//       const nearby = await Driver.find({
//         current_location: {
//           $nearSphere: {
//             $geometry: {
//               type: "Point",
//               coordinates: [pickup_lng, pickup_lat],
//             },
//             $maxDistance: maxRadius,
//           },
//         },
//       }).lean();

//       if (nearby.length === 0) {
//         return res.status(404).json({
//           ...payloadBase,
//           message: "❌ No drivers nearby within 5km radius.",
//         });
//       }

//       const online = nearby.filter((d) => d.is_online);
//       if (online.length === 0) {
//         return res.status(404).json({
//           ...payloadBase,
//           message: "🚫 No drivers online nearby.",
//         });
//       }

//       const capacityMatch = online.filter(
//         (d) => d.available_capacity >= no_of_passenger
//       );
//       if (capacityMatch.length === 0) {
//         return res.status(404).json({
//           ...payloadBase,
//           message: "🚫 No online drivers with enough capacity.",
//         });
//       }

//       const rideTypeMatch = capacityMatch.filter(
//         (d) => d.vehicle_type === ride_type
//       );
//       if (rideTypeMatch.length === 0) {
//         return res.status(404).json({
//           ...payloadBase,
//           message: `🚫 No online drivers with vehicle type "${ride_type}".`,
//         });
//       }

//       return res.status(404).json({
//         ...payloadBase,
//         message: "🚫 No matching driver found.",
//       });
//     }

//     const driversList = nearestDrivers.map((driver) => ({
//       user_id: driver.user_id,
//       name: driver.name,
//       phone: driver.phone,
//       location: driver.current_location,
//       device_id: driver.device_id,
//     }));

//     const driverPayload = {
//       ...payloadBase,
//       message: `✅ Ride request created and found ${driversList.length} matching drivers nearby`,
//       nearest_drivers: driversList, // note the plural 'nearest_drivers'
//     };

//     const broadcastPayload = {
//       response: driverPayload,
//       request: req.body,
//       device_id,
//     };

//     io.emit("ride_request_broadcast", broadcastPayload);

//     return res.status(201).json(driverPayload);
//   } catch (err) {
//     console.error("🔥 Error in ride request:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   }
// };

exports.getRiderRequestById = async (req, res) => {
  const { request_id } = req.params;

  try {
    const request = await rideRequestModel.getRiderRequestById(request_id);

    if (!request) {
      return res.status(404).json({ message: "Ride request not found" });
    }

    return res.status(200).json(request);
  } catch (err) {
    console.error("Error fetching ride request:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getRiderRequestByRiderId = async (req, res) => {
  const { rider_id } = req.params;

  try {
    const request = await rideRequestModel.getRiderRequestByRiderId(rider_id);

    // Check if result is empty array or falsy
    if (!request || request.length === 0) {
      return res.status(404).json({
        message: `No ride requests found for rider ID ${rider_id}`,
        data: [],
      });
    }

    return res.status(200).json({
      message: `Ride requests found for rider ID ${rider_id}`,
      data: request,
    });
  } catch (err) {
    console.error("❌ Error fetching ride request:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// exports.getPopularLocations = async (req, res) => {
//   try {
//     const pickupKey = "popular:pickup_locations";
//     const dropoffKey = "popular:dropoff_locations";

//     const pickupData = await redis.zrange(pickupKey, 0, -1, { rev: true });
//     const dropoffData = await redis.zrange(dropoffKey, 0, -1, { rev: true });

//     const top_pickup_locations =
//       pickupData.length > 3 ? pickupData.slice(0, 3) : pickupData;
//     const top_dropoff_locations =
//       dropoffData.length > 3 ? dropoffData.slice(0, 3) : dropoffData;

//     return res.status(200).json({
//       top_pickup_locations,
//       top_dropoff_locations,
//     });
//   } catch (err) {
//     console.error("🚨 Redis Popular Location Error:", err);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// };

// controllers/rideRequest.controller.js

function safeParseJSON(s) {
  try {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t || t === "null" || t === "undefined") return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Normalize Upstash zrange outputs into [{ member, score }]
function normalizeUpstashWithScores(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Shape A (rare): [{ member, score }, ...]
  if (
    typeof rows[0] === "object" &&
    rows[0] !== null &&
    "member" in rows[0] &&
    "score" in rows[0]
  ) {
    return rows.map((r) => ({ member: r.member, score: Number(r.score) }));
  }

  // Shape B (your case): [member1, score1, member2, score2, ...]
  const out = [];
  for (let i = 0; i < rows.length; i += 2) {
    const m = rows[i];
    const s = Number(rows[i + 1]);
    if (m != null) out.push({ member: m, score: s });
  }
  return out;
}

async function zTopWithScores(redis, key, limit = 3) {
  // Upstash (@upstash/redis)
  if (typeof redis.zrange === "function") {
    const rows = await redis.zrange(key, 0, limit - 1, {
      rev: true,
      withScores: true,
    });
    return normalizeUpstashWithScores(rows);
  }

  // node-redis v4
  if (typeof redis.zRange === "function") {
    const rows = await redis.zRange(key, 0, limit - 1, {
      REV: true,
      WITHSCORES: true,
    });
    return (rows || [])
      .map((r) => ({
        member: r.value ?? r.member,
        score: Number(r.score),
      }))
      .filter((r) => r.member != null);
  }

  // ioredis
  if (typeof redis.zrevrange === "function") {
    const arr = await redis.zrevrange(key, 0, limit - 1, "WITHSCORES");
    const out = [];
    for (let i = 0; i < (arr || []).length; i += 2) {
      const m = arr[i];
      const s = Number(arr[i + 1]);
      if (m != null) out.push({ member: m, score: s });
    }
    return out;
  }

  return [];
}

exports.getPopularLocations = async (req, res) => {
  try {
    const { user_id } = req.params;
    if (!user_id)
      return res.status(400).json({ message: "user_id is required" });

    const pickupKey = `user:${user_id}:popular:pickup`;
    const dropoffKey = `user:${user_id}:popular:dropoff`;

    const [pickupRows, dropoffRows] = await Promise.all([
      zTopWithScores(redis, pickupKey, 3),
      zTopWithScores(redis, dropoffKey, 3),
    ]);

    // Map members (could be JSON string, or already an object from Upstash)
    const mapRow = ({ member, score }) => {
      let obj = null;

      if (typeof member === "object" && member !== null) {
        // Upstash auto-deserialized JSON
        obj = member;
      } else {
        obj = safeParseJSON(member) || null;
      }

      return {
        address: obj?.address ?? String(member),
        lat: typeof obj?.lat === "number" ? obj.lat : null,
        lng: typeof obj?.lng === "number" ? obj.lng : null,
        count: Number.isFinite(score) ? score : 0,
      };
    };

    const top_pickup_locations = (pickupRows || []).map(mapRow);
    const top_dropoff_locations = (dropoffRows || []).map(mapRow);

    return res.status(200).json({
      user_id: String(user_id),
      top_pickup_locations,
      top_dropoff_locations,
    });
  } catch (err) {
    console.error("🚨 Popular Location read error:", err?.message || err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
