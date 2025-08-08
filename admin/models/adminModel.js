const pool = require("../config/db");

// ✅ Fetch users with role 'user'
exports.fetchUsersByRole = async () => {
  const sql = `
    SELECT user_name, email, phone, is_active
    FROM users
    WHERE role = 'user'
  `;
  const [rows] = await pool.query(sql);
  return rows;
};

// ✅ Fetch drivers with license and vehicle info
exports.fetchDrivers = async () => {
  const userQuery = `
  SELECT user_id, user_name, email, phone, is_active
  FROM users
  WHERE role = 'driver'
`;
  const [users] = await pool.query(userQuery);

  const detailedDrivers = await Promise.all(
    users.map(async (user) => {
      const [driverRows] = await pool.query(
        `SELECT driver_id, license_number FROM drivers WHERE user_id = ?`,
        [user.user_id]
      );

      const driverInfo = driverRows[0] || {};
      const driver_id = driverInfo.driver_id || null;
      const license_number = driverInfo.license_number || null;

      let vehicles = [];
      if (driver_id) {
        const [vehicleRows] = await pool.query(
          `SELECT make, color, license_plate FROM driver_vehicles WHERE driver_id = ?`,
          [driver_id]
        );
        vehicles = vehicleRows;
      }

      return {
        user_id: user.user_id,
        user_name: user.user_name,
        email: user.email,
        phone: user.phone,
        is_active: user.is_active,
        driver_id,
        license_number,
        vehicles,
      };
    })
  );

  return detailedDrivers;
};
