// config/db.js
const mysql = require("mysql2");

const poolCore = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  // Driver-side handling: keep dates as strings + treat DB times as UTC.
  // This avoids silent JS Date shifts.
  timezone: "Z", // use UTC in the driver
  dateStrings: true, // return TIMESTAMP/DATETIME as strings
});

// Ensure EVERY new pooled connection runs with Asia/Thimphu session TZ
poolCore.on("connection", (conn) => {
  conn.query("SET time_zone = '+06:00'");
  // Optional: enforce strict SQL if you want
  // conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
});

// Export promise wrapper for async/await usage everywhere else
const pool = poolCore.promise();
module.exports = pool;

// (optional) quick sanity check at boot:
// (async () => {
//   const [rows] = await pool.query("SELECT @@time_zone AS session_tz, @@global.time_zone AS global_tz");
//   console.log('[DB TZ CHECK]', rows[0]); // expect session_tz: +06:00
// })();
