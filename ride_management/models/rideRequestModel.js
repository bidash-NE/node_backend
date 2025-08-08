const db = require("../config/db");

// Insert ride request and return insertId
exports.createRideRequest = async (rideRequestData) => {
  const {
    rider_id,
    ride_type_id,
    fare_estimate,
    pickup_lat,
    pickup_lng,
    dropoff_lat,
    dropoff_lng,
    pickup_address,
    dropoff_address,
    no_of_passenger,
  } = rideRequestData;

  const sql = `
    INSERT INTO ride_requests (
      rider_id, ride_type_id, fare_estimate,
      pickup_loc, dropoff_loc,
      pickup_address, dropoff_address,no_of_passenger
    ) VALUES (
      ?, ?, ?,
      ST_GeomFromText(?), ST_GeomFromText(?),
      ?, ?, ?
    )
  `;

  const [result] = await db.query(sql, [
    rider_id,
    ride_type_id,
    fare_estimate,
    `POINT(${pickup_lat} ${pickup_lng})`,
    `POINT(${dropoff_lat} ${dropoff_lng})`,
    pickup_address,
    dropoff_address,
    no_of_passenger,
  ]);

  return result.insertId;
};
// function to log initial ride status
exports.addRideStatusHistory = async (ride_request_id, status = "pending") => {
  await db.query(
    `INSERT INTO ride_status_history (ride_request_id, status) VALUES (?, ?)`,
    [ride_request_id, status]
  );
};
// Insert payment record
exports.createPayment = async ({ ride_request_id, amount_cents, method }) => {
  const sql = `
    INSERT INTO payments (
      ride_request_id, amount_cents, method
    ) VALUES (?, ?, ?)
  `;

  const [result] = await db.query(sql, [
    ride_request_id,
    amount_cents,
    method.toUpperCase(),
  ]);

  return result.insertId;
};

// GET Ride Request by ID
exports.getRiderRequestById = async (request_id) => {
  const [result] = await db.query(
    "SELECT * FROM ride_requests WHERE ride_request_id = ?",
    [request_id]
  );
  return result[0]; // Return a single object
};
exports.getRiderRequestByRiderId = async (rider_id) => {
  const [result] = await db.query(
    "SELECT * FROM ride_requests WHERE rider_id = ?",
    [rider_id]
  );
  // console.log(result);
  return result;
};
