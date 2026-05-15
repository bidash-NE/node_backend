const redis = require("../config/redis");
const {
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
  buildErrorKey,
} = require("../models/scheduledOrderModel");

const THIRTY_MIN_MS = 30 * 60 * 1000;

// In services/scheduledOrderCleanupService.js
async function cleanupRejectedScheduledOrders() {
  try {
    console.log("🧹 Running scheduled order cleanup...");

    const jobIds = await redis.zrange(ZSET_KEY, 0, -1);
    console.log(`📊 Found ${jobIds.length} orders in ZSET`);

    // ... rest of code

    for (let i = 0; i < results.length; i++) {
      const raw = results[i][1];
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);
        const status = data?.order_payload?.status;
        const rejectedAt = data?.order_payload?.rejected_at;

        console.log(
          `📊 Order ${data.job_id}: status=${status}, rejectedAt=${rejectedAt}`,
        );

        if (status !== "REJECTED" || !rejectedAt) continue;

        const rejectedTime = new Date(rejectedAt).getTime();
        const ageMinutes = (now - rejectedTime) / (1000 * 60);

        console.log(
          `⏰ Order ${data.job_id} rejected ${ageMinutes.toFixed(1)} minutes ago`,
        );

        if (now - rejectedTime >= THIRTY_MIN_MS) {
          console.log(
            `🗑 DELETING ${data.job_id} (age: ${ageMinutes.toFixed(1)} mins)`,
          );
          // Delete...
        } else {
          console.log(
            `⏳ Keeping ${data.job_id} (needs ${(30 - ageMinutes).toFixed(1)} more minutes)`,
          );
        }
      } catch (err) {
        console.error("❌ Failed parsing:", err);
      }
    }
  } catch (err) {
    console.error("❌ Cleanup service error:", err);
  }
}

module.exports = {
  cleanupRejectedScheduledOrders,
};
