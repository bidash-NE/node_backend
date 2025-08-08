const pool = require("../config/db");

const insertDriverVehicle = async (driver_id, vehicle) => {
  const {
    make,
    model,
    year,
    color,
    license_plate,
    vehicle_type,
    capacity,
    features,
    insurance_expiry,
  } = vehicle;

  await pool.query(
    `INSERT INTO driver_vehicles 
    (driver_id, make, model, year, color, license_plate, vehicle_type, capacity, features, insurance_expiry) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      driver_id,
      make,
      model,
      year,
      color,
      license_plate,
      vehicle_type,
      capacity,
      features.join(","),
      insurance_expiry,
    ]
  );
};

module.exports = { insertDriverVehicle };
