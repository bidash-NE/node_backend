// src/matching/presence.js
import { getRedis } from "./redis.js";
import { geoKey, onlineSet, driverHash } from "./redisKeys.js";

const redis = getRedis();

const toStr = (v) => (v == null ? "" : String(v));
const isNum = (n) => Number.isFinite(n);

/**
 * NOTE:
 * - We now use geoKey(cityId, serviceType, serviceCode) and onlineSet(cityId, serviceType, serviceCode)
 *   consistently everywhere (previously mixed arities).
 * - We track socket IDs under `${driverHash(id)}:sockets` to decide if a driver still has live sockets
 *   when a single socket disconnects.
 */
export const presence = {
  async setOnline(
    driverId,
    { cityId, serviceType, serviceCode, socketId, lat, lng }
  ) {
    const member = toStr(driverId);
    const key = geoKey(cityId, serviceType, serviceCode);
    const hkey = driverHash(member);
    const oset = onlineSet(cityId, serviceType, serviceCode);

    const pipe = redis.multi();
    if (isNum(lat) && isNum(lng)) {
      pipe.geoadd(key, Number(lng), Number(lat), member);
    }
    pipe.sadd(oset, member);

    pipe.hset(hkey, {
      status: "online",
      cityId,
      serviceType,
      serviceCode,
      lastSeen: Date.now(),
      lat: isNum(lat) ? Number(lat) : "",
      lng: isNum(lng) ? Number(lng) : "",
    });
    if (socketId) pipe.sadd(`${hkey}:sockets`, socketId);
    pipe.expire(hkey, 60 * 60);

    await pipe.exec();

    console.log(
      `[presence] driver ${driverId} online at ${lat},${lng} in ${cityId}:${serviceType} ${serviceCode}`
    );
  },

  /**
   * If socketId is provided, we remove that socket from the driver's socket set.
   * Only mark fully offline if that set becomes empty.
   */
  async setOffline(driverId, socketId = null) {
    const member = toStr(driverId);
    const hkey = driverHash(member);

    // Remove socket from live set (if any)
    if (socketId) {
      await redis.srem(`${hkey}:sockets`, socketId);
      const remaining = await redis.scard(`${hkey}:sockets`);
      if (remaining > 0) {
        // Still online via other sockets; just mark lastSeen
        await redis.hset(hkey, { lastSeen: Date.now() });
        console.log(`[presence] driver ${driverId} still online via ${remaining} socket(s)`);
        return;
      }
    }

    const meta = await redis.hgetall(hkey);
    const cityId = meta.cityId || "thimphu";
    const serviceType = meta.serviceType || "bike";
    const serviceCode = meta.serviceCode || "default";

    const key = geoKey(cityId, serviceType, serviceCode);
    const oset = onlineSet(cityId, serviceType, serviceCode);

    const pipe = redis.multi();
    pipe.zrem(key, member);
    pipe.srem(oset, member);
    pipe.hset(hkey, { status: "offline", lastSeen: Date.now() });
    await pipe.exec();

    console.log(
      `[presence] driver ${driverId} offline in ${cityId}:${serviceType} ${serviceCode}`
    );
  },

  async updateLocation(driverId, { cityId, serviceType, serviceCode, lat, lng }) {
    if (!isNum(lat) || !isNum(lng)) {
      console.log("[presence.updateLocation] skip invalid", { driverId, lat, lng });
      return 0;
    }

    const member = toStr(driverId);
    const key = geoKey(cityId, serviceType, serviceCode);
    const hkey = driverHash(member);

    const pipe = redis.multi();
    pipe.geoadd(key, Number(lng), Number(lat), member);
    pipe.hset(hkey, {
      lat: Number(lat),
      lng: Number(lng),
      lastSeen: Date.now(),
    });
    pipe.expire(hkey, 60 * 60);

    const res = await pipe.exec();
    console.log("[presence.updateLocation] write", {
      key,
      member,
      lat,
      lng,
      res,
    });
    return res;
  },

  async getNearby({
    cityId,
    serviceType,
    serviceCode,
    lat,
    lng,
    radiusM = 5000,
    count = 25,
  }) {
    const key = geoKey(cityId, serviceType, serviceCode);
    try {
      const res = await redis.geosearch(
        key,
        "FROMLONLAT",
        Number(lng),
        Number(lat),
        "BYRADIUS",
        radiusM,
        "m",
        "ASC",
        "COUNT",
        count,
        "WITHCOORD"
      );
      return res.map(([id, [lon, la]]) => ({
        id,
        lat: parseFloat(la),
        lng: parseFloat(lon),
      }));
    } catch (e) {
      console.warn(
        "[presence.getNearby] geosearch failed, fallback to georadius",
        e.message
      );
      try {
        const legacy = await redis.georadius(
          key,
          Number(lng),
          Number(lat),
          radiusM,
          "m",
          "WITHCOORD",
          "ASC",
          "COUNT",
          count
        );
        return legacy.map(([id, [lon, la]]) => ({
          id,
          lat: parseFloat(la),
          lng: parseFloat(lon),
        }));
      } catch (err) {
        console.error("[presence.getNearby] georadius fallback failed:", err);
        return [];
      }
    }
  },
};

export default { presence };
