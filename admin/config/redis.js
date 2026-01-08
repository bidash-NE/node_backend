// config/redis.js  ✅ (ADMIN SIDE) ioredis setup
const IORedis = require("ioredis");

let redis;

/**
 * Env supported:
 *  - REDIS_URL=redis://:password@host:6379/0
 *  - or REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB
 */
function getRedis() {
  if (redis) return redis;

  const url = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();

  if (url) {
    redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  } else {
    redis = new IORedis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }

  redis.on("connect", () => console.log("[redis] connected"));
  redis.on("error", (e) => console.error("[redis] error", e?.message || e));

  return redis;
}

module.exports = { getRedis };
