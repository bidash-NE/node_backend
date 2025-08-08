// scripts/warmupRideTypes.js
const redis = require("../config/redis");
const db = require("../config/db");

async function warmupRideTypesIfNeeded() {
  try {
    const cacheKey = "ride_types";

    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("✅ ride_types found in Redis cache.");
      return;
    }

    console.log("⚡ ride_types not found in Redis. Warming up...");
    const [rows] = await db.query("SELECT * FROM ride_types");

    // Make sure to stringify before saving in Redis
    await redis.set(cacheKey, JSON.stringify(rows), { ex: 3600 }); // 1 hour TTL

    console.log("✅ ride_types cached successfully.");
  } catch (err) {
    console.error("❌ Error warming ride_types cache:", err);
  }
}

module.exports = warmupRideTypesIfNeeded;
