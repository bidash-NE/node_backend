const Driver = require("../models/driverModel");
const { emitAllDrivers } = require("./emitDriverController");

// Converts current UTC time to Bhutan time Date object
const getBhutanTimeDate = () => {
  const bhutanTimeString = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Thimphu",
  });
  return new Date(bhutanTimeString);
};

// Converts UTC date to Bhutan time string (for display)
const formatToBhutanTime = (utcDate) => {
  return new Date(utcDate).toLocaleString("en-GB", {
    timeZone: "Asia/Thimphu",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

// ✅ Update driver's location & online status
const handleDriverLocationUpdate = async (socket, data) => {
  const { user_id, latitude, longitude } = data;

  try {
    const bhutanTime = getBhutanTimeDate();

    const updatedDriver = await Driver.findOneAndUpdate(
      { user_id },
      {
        $set: {
          latitude,
          longitude,
          is_online: true,
          updatedAt: formatToBhutanTime(bhutanTime),
          current_location_updated_at: bhutanTime,
        },
      },
      { new: true }
    );

    if (!updatedDriver) {
      return socket.emit("locationUpdateError", {
        message: "Driver not found",
      });
    }

    console.log(
      `✅ Location & status updated for user_id: ${user_id} at Bhutan time ${formatToBhutanTime(
        bhutanTime
      )}`
    );

    socket.emit("locationUpdateSuccess", {
      message: "Location and active status updated successfully!",
      bhutan_time: formatToBhutanTime(bhutanTime),
    });

    const allDrivers = await emitAllDrivers(socket);
    socket.broadcast.emit("allDriversData", allDrivers);
    console.log(allDrivers);
  } catch (err) {
    console.error("❌ Error updating driver info:", err.message);
    socket.emit("locationUpdateError", {
      message: "Failed to update driver location",
    });
  }
};

// ✅ Update driver's is_online to false on disconnect
const handleDriverDisconnect = async (socket, user_id) => {
  try {
    const bhutanTime = getBhutanTimeDate();

    const updated = await Driver.findOneAndUpdate(
      { user_id },
      {
        $set: {
          is_online: false,
          updatedAt: formatToBhutanTime(bhutanTime),
        },
      },
      { new: true }
    );

    if (updated) {
      console.log(
        `🔴 Driver (user_id: ${user_id}) set to offline at ${formatToBhutanTime(
          bhutanTime
        )}`
      );

      // Broadcast the updated driver list to everyone
      const allDrivers = await emitAllDrivers(socket);
      socket.broadcast.emit("allDriversData", allDrivers);
    }
  } catch (err) {
    console.error("❌ Error setting driver offline:", err.message);
  }
};

module.exports = {
  handleDriverLocationUpdate,
  handleDriverDisconnect,
  formatToBhutanTime,
};
