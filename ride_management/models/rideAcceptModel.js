const db = require("../config/db");

exports.getAcceptedRideByRiderId = async (rider_id) => {
  const [result] = await db.query(
    "SELECT * FROM accepted_rides WHERE passenger_id = ?",
    [rider_id]
  );
  return result[0]; // Return a single object
};
