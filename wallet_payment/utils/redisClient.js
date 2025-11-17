// utils/redisClient.js
const { createClient } = require("redis");

const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (err) => {
  console.error("Redis error:", err);
});

(async () => {
  try {
    if (!redis.isOpen) {
      await redis.connect();
      console.log("[Redis] Connected");
    }
  } catch (err) {
    console.error("[Redis] Connection error:", err);
  }
})();

module.exports = redis;
