const DriverMongo = require("../models/driverModel");

exports.updateDriverLocation = async (req, res) => {
  const { user_id, coordinates } = req.body;

  if (!user_id || !Array.isArray(coordinates) || coordinates.length !== 2) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  try {
    // ✅ Add 6 hours to current UTC time to reflect Bhutan Time (UTC+6)
    const updatedTime = new Date(new Date().getTime() + 6 * 60 * 60 * 1000);

    const updatedDriver = await DriverMongo.findOneAndUpdate(
      { user_id },
      {
        $set: {
          current_location: {
            type: "Point",
            coordinates,
          },
          current_location_updated_at: updatedTime,
        },
      },
      { new: true }
    );

    if (!updatedDriver) {
      return res
        .status(404)
        .json({ error: "Driver not found for given user_id" });
    }

    res.status(200).json({
      message: "Driver location updated successfully",
      driver: updatedDriver,
    });
  } catch (err) {
    console.error("Error updating driver location:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
