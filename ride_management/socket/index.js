const db = require("../config/db");

module.exports = (io) => {
  io.on("connection", (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // 🔐 Join a passenger's personal room (for private notifications)
    socket.on("joinPersonalRoom", (userId) => {
      const roomId = `user_${userId}`;
      socket.join(roomId);
      console.log(`📥 Socket ${socket.id} joined personal room: ${roomId}`);
    });

    // 🚕 Passenger joins a driver's room AFTER ride is accepted
    socket.on("joinDriverRoom", (driverUserId) => {
      const roomId = `driver_${driverUserId}`;
      socket.join(roomId);
      console.log(`📥 Socket ${socket.id} joined driver room: ${roomId}`);
    });

    // 🌐 Generic fallback room join (custom uses)
    socket.on("joinRoom", (roomId) => {
      socket.join(roomId);
      console.log(`📥 Socket ${socket.id} joined room: ${roomId}`);
    });

    // 🔄 Passenger attempts to rejoin a driver room (e.g. after reconnecting)
    socket.on("rejoinDriverRoom", async ({ passenger_id, ride_request_id }) => {
      try {
        const connection = await db.getConnection();

        const [rows] = await connection.query(
          `SELECT driver_id FROM ride_requests 
           WHERE ride_request_id = ? AND passenger_id = ? AND status = 'accepted'`,
          [ride_request_id, passenger_id]
        );

        connection.release();

        if (rows.length === 0) {
          console.log(
            `❌ Rejoin denied: No accepted ride found for passenger ${passenger_id}, ride ${ride_request_id}`
          );
          socket.emit("rejoinFailed", {
            message: "Ride not accepted or invalid for rejoin.",
          });
          return;
        }

        const driver_id = rows[0].driver_id;
        const driverRoom = `driver_${driver_id}`;

        socket.join(driverRoom);
        console.log(
          `🔄 Passenger ${passenger_id} rejoined driver room: ${driverRoom}`
        );

        socket.emit("rejoinSuccess", {
          driver_room: driverRoom,
          message: "Successfully rejoined the driver room.",
        });
      } catch (err) {
        console.error("🔴 Error during rejoinDriverRoom:", err.message);
        socket.emit("rejoinFailed", {
          message: "Error while trying to rejoin room.",
        });
      }
    });

    // 🆕 Passenger sends a new ride request to a specific driver
    socket.on("rideRequested", (data) => {
      const { rider_id, driver_id, ride_id, pickup_address } = data;
      const driverRoom = `driver_${driver_id}`;
      console.log(
        `📤 [RIDE REQUESTED] Rider ${rider_id} → Driver ${driver_id}`
      );
      console.log(`📍 Pickup Address: ${pickup_address}`);
      console.log(`📦 Emitting to Room: ${driverRoom}`);

      io.to(driverRoom).emit("newRideRequest", {
        ride_id,
        rider_id,
        pickup_address,
        message: "You have a new ride request!",
      });
    });

    // ✅ Driver accepted a ride (update passenger's room)
    socket.on("rideAccepted", (data) => {
      const { driver_id, rider_id, ride_id } = data;
      const riderRoom = `user_${rider_id}`;
      console.log(
        `✅ [RIDE ACCEPTED] Driver ${driver_id} accepted Ride ${ride_id}`
      );
      console.log(`📦 Notifying Rider in Room: ${riderRoom}`);

      io.to(riderRoom).emit("rideAccepted", {
        ride_id,
        driver_id,
        message: "Your ride has been accepted!",
      });
    });

    // 📍 Driver is updating their location
    socket.on("driverLocationUpdate", ({ driver_id, location }) => {
      const roomId = `driver_${driver_id}`;
      console.log(`📍 Driver ${driver_id} sent location:`, location);

      // Broadcast to ONLY users inside the driver's room
      io.to(roomId).emit("driverLocation", {
        driver_id,
        location,
        timestamp: new Date().toISOString(),
      });
    });

    // ❌ Handle disconnect
    socket.on("disconnect", () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });
};
