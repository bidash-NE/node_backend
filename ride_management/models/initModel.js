const db = require("../config/db");

const tables = [
  {
    name: "ride_types",
    sql: `
      CREATE TABLE ride_types (
        ride_type_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(50) NOT NULL,
        base_fare INT NOT NULL,
        per_km INT NOT NULL,
        per_min INT NOT NULL
      );
    `,
  },
  {
    name: "ride_requests",
    sql: `
      CREATE TABLE ride_requests (
        ride_request_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        rider_id BIGINT UNSIGNED NOT NULL,
        driver_id BIGINT UNSIGNED NULL,
        ride_type_id BIGINT UNSIGNED NOT NULL,
        status ENUM('pending','accepted','in_progress','completed','cancelled') DEFAULT 'pending',
        fare_estimate INT,
        no_of_passenger INT,
        pickup_loc POINT NOT NULL,
        dropoff_loc POINT NOT NULL,
        pickup_address VARCHAR(255),
        dropoff_address VARCHAR(255),
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scheduled_time TIMESTAMP NULL,
        accepted_at TIMESTAMP NULL,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        FOREIGN KEY (rider_id) REFERENCES users(user_id),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
        FOREIGN KEY (ride_type_id) REFERENCES ride_types(ride_type_id)
      );
    `,
  },
  {
    name: "ride_status_history",
    sql: `
      CREATE TABLE ride_status_history (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        ride_request_id BIGINT UNSIGNED NOT NULL,
        status ENUM('pending','accepted','in_progress','completed','cancelled') NOT NULL,
        changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ride_request_id) REFERENCES ride_requests(ride_request_id)
      );
    `,
  },
  {
    name: "payments",
    sql: `
      CREATE TABLE payments (
        payment_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        ride_request_id BIGINT UNSIGNED NOT NULL,
        amount_cents INT NOT NULL,
        method ENUM('CASH','CARD','GRABPAY') NOT NULL,
        paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ride_request_id) REFERENCES ride_requests(ride_request_id)
      );
    `,
  },
  {
    name: "earnings",
    sql: `
      CREATE TABLE earnings (
        earning_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        driver_id BIGINT UNSIGNED NOT NULL,
        ride_request_id BIGINT UNSIGNED NOT NULL,
        amount_cents INT NOT NULL,
        paid_out BOOLEAN DEFAULT FALSE,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
        FOREIGN KEY (ride_request_id) REFERENCES ride_requests(ride_request_id)
      );
    `,
  },
  {
    name: "driver_locations",
    sql: `
      CREATE TABLE driver_locations (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        driver_id BIGINT UNSIGNED NOT NULL,
        loc POINT NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      );
    `,
  },
  {
    name: "accepted_rides",
    sql: `
      CREATE TABLE accepted_rides (
        accept_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        ride_request_id BIGINT UNSIGNED NOT NULL,
        driver_id BIGINT UNSIGNED NOT NULL,
        passenger_id BIGINT UNSIGNED NOT NULL,
        status ENUM('accepted', 'rejected', 'cancelled', 'completed') DEFAULT 'accepted',
        accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ride_request_id) REFERENCES ride_requests(ride_request_id),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
        FOREIGN KEY (passenger_id) REFERENCES users(user_id)
      );
    `,
  },
];

const initRideTables = async () => {
  for (const table of tables) {
    try {
      const [rows] = await db.query(`SHOW TABLES LIKE ?`, [table.name]);
      if (rows.length === 0) {
        await db.query(table.sql);
        console.log(`✅ Table '${table.name}' created.`);
      } else {
        // console.log(`ℹ️ Table '${table.name}' already exists.`);
      }
    } catch (err) {
      console.error(
        `❌ Error processing table '${table.name}': ${err.message}`
      );
      if (
        ["ride_requests", "ride_types", "accepted_rides"].includes(table.name)
      ) {
        break;
      }
    }
  }
};

module.exports = initRideTables;
