// config/redis.js
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("connect", () => console.log("[redis] connected"));
redis.on("error", (e) => console.log("[redis] error:", e.message));

module.exports = redis;
