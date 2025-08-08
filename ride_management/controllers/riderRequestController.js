const Joi = require("joi");
const db = require("../config/db");
const redis = require("../config/redis");
const rideRequestModel = require("../models/rideRequestModel");
const Driver = require("../models/driverModel");

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

//     // Find nearest driver
//     const maxRadius = 5000;
//     let radius = 1000;
//     let nearestDriver = null;

//     while (radius <= maxRadius && !nearestDriver) {
//       nearestDriver = await Driver.find({
//         is_online: true,
//         available_capacity: { $gte: no_of_passenger, $gt: 0 },
//         current_location: {
//           $near: {
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

//     if (!nearestDriver) {
//       const noDriverPayload = {
//         ...payloadBase,
//         message: "Ride request created, but no drivers available currently.",
//         nearest_driver: null,
//       };

//       io.to(rideRoom).emit("ride_request_broadcast", {
//         response: noDriverPayload,
//         request: req.body,
//         device_id,
//       });

//       return res.status(201).json(noDriverPayload);
//     }

//     const driverPayload = {
//       ...payloadBase,
//       message: "Ride request created and searching for driver",
//       nearest_driver: {
//         user_id: nearestDriver.user_id,
//         name: nearestDriver.name,
//         phone: nearestDriver.phone,
//         location: nearestDriver.current_location,
//         device_id: nearestDriver.device_id,
//       },
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
exports.requestRide = async (req, res) => {
  const io = req.app.locals.io;

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
      console.log("❌ Validation error:", error.details[0].message);
      return res.status(400).json({ error: error.details[0].message });
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

    // Get or cache ride types
    let rideTypes = [];
    try {
      const cachedRideTypes = await redis.get("ride_types");
      if (cachedRideTypes) {
        rideTypes = JSON.parse(cachedRideTypes);
      } else {
        const [rows] = await db.query("SELECT * FROM ride_types");
        rideTypes = rows;
        await redis.set("ride_types", JSON.stringify(rows), "EX", 3600);
      }
    } catch (err) {
      console.error("❌ Redis error:", err.message);
      const [rows] = await db.query("SELECT * FROM ride_types");
      rideTypes = rows;
    }

    const rideType = rideTypes.find((type) => type.name === ride_type);
    if (!rideType) {
      return res.status(400).json({ error: "Invalid ride type selected" });
    }

    // Calculate fare
    const fare_estimate =
      rideType.base_fare +
      Math.round((distance_meters / 1000) * rideType.per_km) +
      Math.round((duration_seconds / 60) * rideType.per_min);

    // Save ride request
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

    // Create payment record
    await rideRequestModel.createPayment({
      ride_request_id,
      amount_cents: fare_estimate,
      method: payment_method,
    });

    // Update Redis popular locations
    try {
      if (dropoff_address) {
        await redis.zincrby("popular:dropoff_locations", 1, dropoff_address);
        if ((await redis.ttl("popular:dropoff_locations")) === -1) {
          await redis.expire("popular:dropoff_locations", 86400);
        }
      }

      if (pickup_address) {
        await redis.zincrby("popular:pickup_locations", 1, pickup_address);
        if ((await redis.ttl("popular:pickup_locations")) === -1) {
          await redis.expire("popular:pickup_locations", 86400);
        }
      }
    } catch (err) {
      console.warn("⚠️ Redis location tracking error:", err.message);
    }

    // Get rider's device ID
    let device_id = null;
    try {
      const [rows] = await db.query(
        "SELECT device_id FROM user_devices WHERE user_id = ?",
        [rider_id]
      );
      if (rows.length > 0) device_id = rows[0].device_id;
    } catch (err) {
      console.warn("⚠️ Device ID fetch error:", err.message);
    }

    // Find nearest drivers (MongoDB)
    const maxRadius = 5000;
    let radius = 1000;
    let nearestDrivers = [];
    while (radius <= maxRadius && nearestDrivers.length === 0) {
      nearestDrivers = await Driver.find({
        is_online: true,
        available_capacity: { $gte: no_of_passenger },
        vehicle_type: ride_type,
        current_location: {
          $nearSphere: {
            $geometry: {
              type: "Point",
              coordinates: [pickup_lng, pickup_lat],
            },
            $maxDistance: radius,
          },
        },
      }).lean();

      radius += 1000;
    }

    const rideRoom = `ride_${ride_request_id}`;
    if (socketId && io.sockets.sockets.get(socketId)) {
      io.sockets.sockets.get(socketId).join(rideRoom);
    }

    const payloadBase = {
      request_id: ride_request_id,
      fare_estimate,
    };

    if (!nearestDrivers || nearestDrivers.length === 0) {
      // Perform analysis to explain why
      const nearby = await Driver.find({
        current_location: {
          $nearSphere: {
            $geometry: {
              type: "Point",
              coordinates: [pickup_lng, pickup_lat],
            },
            $maxDistance: maxRadius,
          },
        },
      }).lean();

      if (nearby.length === 0) {
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
        (d) => d.available_capacity >= no_of_passenger
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

      return res.status(404).json({
        ...payloadBase,
        message: "🚫 No matching driver found.",
      });
    }

    const driversList = nearestDrivers.map((driver) => ({
      user_id: driver.user_id,
      name: driver.name,
      phone: driver.phone,
      location: driver.current_location,
      device_id: driver.device_id,
    }));

    const driverPayload = {
      ...payloadBase,
      message: `✅ Ride request created and found ${driversList.length} matching drivers nearby`,
      nearest_drivers: driversList, // note the plural 'nearest_drivers'
    };

    const broadcastPayload = {
      response: driverPayload,
      request: req.body,
      device_id,
    };

    io.emit("ride_request_broadcast", broadcastPayload);

    return res.status(201).json(driverPayload);
  } catch (err) {
    console.error("🔥 Error in ride request:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

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

exports.getPopularLocations = async (req, res) => {
  try {
    const pickupKey = "popular:pickup_locations";
    const dropoffKey = "popular:dropoff_locations";

    const pickupData = await redis.zrange(pickupKey, 0, -1, { rev: true });
    const dropoffData = await redis.zrange(dropoffKey, 0, -1, { rev: true });

    const top_pickup_locations =
      pickupData.length > 3 ? pickupData.slice(0, 3) : pickupData;
    const top_dropoff_locations =
      dropoffData.length > 3 ? dropoffData.slice(0, 3) : dropoffData;

    return res.status(200).json({
      top_pickup_locations,
      top_dropoff_locations,
    });
  } catch (err) {
    console.error("🚨 Redis Popular Location Error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
