const db = require("../config/db"); // MySQL connection pool
const Driver = require("../models/driverModel"); // MongoDB model
const rideAcceptedModel = require("../models/rideAcceptModel");

// exports.acceptRide = async (req, res) => {
//   const { ride_request_id, passenger_id, driver_user_id } = req.body; // driver_user_id is the SQL & Mongo user_id

//   console.log("🚗 Accept Ride Request:");
//   // console.log("ride_request_id:", ride_request_id);
//   // console.log("driver_user_id:", driver_user_id);
//   // console.log("passenger_id:", passenger_id);

//   if (!ride_request_id || !driver_user_id || !passenger_id) {
//     return res.status(400).json({ message: "Missing required fields." });
//   }

//   const connection = await db.getConnection();

//   try {
//     await connection.beginTransaction();

//     // 1. Get driver_id from MySQL using user_id
//     const [driverResult] = await connection.query(
//       `SELECT driver_id FROM drivers WHERE user_id = ?`,
//       [driver_user_id]
//     );

//     if (driverResult.length === 0) {
//       throw new Error("Driver not found in MySQL.");
//     }

//     const driver_id = driverResult[0].driver_id;

//     // 2. Fetch no_of_passenger from ride_requests
//     const [rideRows] = await connection.query(
//       `SELECT no_of_passenger FROM ride_requests WHERE ride_request_id = ?`,
//       [ride_request_id]
//     );

//     if (rideRows.length === 0) {
//       throw new Error("Ride request not found.");
//     }

//     const no_of_passenger = rideRows[0].no_of_passenger;

//     // 3. Insert into accepted_rides with proper driver_id
//     await connection.query(
//       `INSERT INTO accepted_rides (ride_request_id, driver_id, passenger_id)
//        VALUES (?, ?, ?)`,
//       [ride_request_id, driver_id, passenger_id]
//     );

//     // 4. Update ride_requests with driver_id and status
//     await connection.query(
//       `UPDATE ride_requests
//        SET status = 'accepted', accepted_at = NOW(), driver_id = ?
//        WHERE ride_request_id = ?`,
//       [driver_id, ride_request_id]
//     );

//     await connection.commit();
//     connection.release();

//     // 5. Update MongoDB available_capacity using user_id
//     const updatedDriver = await Driver.findOneAndUpdate(
//       { user_id: driver_user_id },
//       { $inc: { available_capacity: -no_of_passenger } },
//       { new: true }
//     );

//     if (!updatedDriver) {
//       return res.status(404).json({ message: "Driver not found in MongoDB." });
//     }

//     // 6. Emit socket notifications
//     const io = req.app.locals.io;

//     // Passenger personal room notification
//     io.to(`user_${passenger_id}`).emit("rideAccepted", {
//       ride_request_id,
//       driver_user_id,
//       message: "Your ride request has been accepted by a driver.",
//     });

//     // Notify passenger to join driver room
//     io.to(`user_${passenger_id}`).emit("joinDriverRoom", driver_user_id);

//     // Notify driver (optional)
//     io.to(`driver_${driver_user_id}`).emit("rideAccepted", {
//       ride_request_id,
//       passenger_id,
//       message: "You have accepted a ride request.",
//     });

//     res.status(200).json({
//       message: "Ride accepted and capacity updated.",
//       updated_capacity: updatedDriver.available_capacity,
//     });
//   } catch (error) {
//     await connection.rollback();
//     connection.release();
//     console.error("Error accepting ride:", error);
//     res
//       .status(500)
//       .json({ message: "Error accepting ride", error: error.message });
//   }
// };
exports.acceptRide = async (req, res) => {
  const { ride_request_id, passenger_id, driver_user_id } = req.body;

  if (!ride_request_id || !driver_user_id || !passenger_id) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  const connection = await db.getConnection();
  const io = req.app.locals.io;

  try {
    await connection.beginTransaction();

    // 1. Check if the ride is already accepted
    const [checkStatusRows] = await connection.query(
      `SELECT status FROM ride_requests WHERE ride_request_id = ? FOR UPDATE`,
      [ride_request_id]
    );

    if (checkStatusRows.length === 0) {
      throw new Error("Ride request not found.");
    }

    if (checkStatusRows[0].status === "accepted") {
      await connection.rollback();
      connection.release();
      return res.status(409).json({
        message: "Ride has already been accepted by another driver.",
      });
    }

    // 2. Get driver_id from MySQL using driver_user_id
    const [driverResult] = await connection.query(
      `SELECT driver_id FROM drivers WHERE user_id = ?`,
      [driver_user_id]
    );

    if (driverResult.length === 0) {
      throw new Error("Driver not found in MySQL.");
    }

    const driver_id = driverResult[0].driver_id;

    // 3. Fetch no_of_passenger from ride_requests
    const [rideRows] = await connection.query(
      `SELECT no_of_passenger FROM ride_requests WHERE ride_request_id = ?`,
      [ride_request_id]
    );

    const no_of_passenger = rideRows[0].no_of_passenger;

    // 4. Insert into accepted_rides
    await connection.query(
      `INSERT INTO accepted_rides (ride_request_id, driver_id, passenger_id)
       VALUES (?, ?, ?)`,
      [ride_request_id, driver_id, passenger_id]
    );

    // 5. Update ride_requests with accepted status
    await connection.query(
      `UPDATE ride_requests 
       SET status = 'accepted', accepted_at = NOW(), driver_id = ? 
       WHERE ride_request_id = ?`,
      [driver_id, ride_request_id]
    );
    console.log("🚗 Ride Request Accepted:");

    await connection.commit();
    connection.release();

    // 6. Update MongoDB driver's available capacity
    const updatedDriver = await Driver.findOneAndUpdate(
      { user_id: driver_user_id },
      { $inc: { available_capacity: -no_of_passenger } },
      { new: true }
    );

    if (!updatedDriver) {
      return res.status(404).json({ message: "Driver not found in MongoDB." });
    }

    // 7. Socket.IO Notifications

    // Notify the passenger their ride is accepted
    io.to(`user_${passenger_id}`).emit("rideAccepted", {
      ride_id: ride_request_id,
      driver_id: driver_user_id,
      message: "Your ride request has been accepted by a driver.",
    });

    // Ask passenger to join driver's ride room
    io.to(`user_${passenger_id}`).emit("joinDriverRoom", {
      driver_id: driver_user_id,
      ride_id: ride_request_id,
    });

    // Notify the accepting driver
    io.to(`driver_${driver_user_id}`).emit("rideAccepted", {
      ride_id: ride_request_id,
      passenger_id,
      message: "You have accepted the ride request.",
    });

    // Inform all others to remove this ride from list
    io.emit("cancelRideRequestForOthers", {
      ride_id: ride_request_id,
      message: "This ride request has already been accepted.",
    });

    res.status(200).json({
      message: "Ride accepted and capacity updated.",
      updated_capacity: updatedDriver.available_capacity,
    });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error("❌ Error accepting ride:", error);
    res.status(500).json({
      message: "Error accepting ride",
      error: error.message,
    });
  }
};

exports.getAcceptedRideByRiderId = async (req, res) => {
  const { rider_id } = req.params;

  try {
    const request = await rideAcceptedModel.getAcceptedRideByRiderId(rider_id);

    if (!request) {
      return res.status(404).json({
        message: "Ride Accepted not found for the rider with ID " + rider_id,
      });
    }

    return res.status(200).json(request);
  } catch (err) {
    console.error("Error fetching ride request:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
