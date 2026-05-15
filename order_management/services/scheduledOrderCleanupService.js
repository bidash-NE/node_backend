const redis = require("../config/redis");
const {
  ZSET_KEY,
  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
  buildErrorKey,
} = require("../models/scheduledOrderModel");

const THIRTY_MIN_MS = 30 * 60 * 1000;

async function cleanupRejectedScheduledOrders() {
  try {
    console.log("🧹 Running scheduled order cleanup...");

    // Get all scheduled jobs
    const jobIds = await redis.zrange(ZSET_KEY, 0, -1);
    console.log(`📊 Found ${jobIds.length} orders in ZSET`);

    if (!jobIds.length) return;

    // ✅ IMPORTANT: Fetch all jobs data
    const pipeline = redis.pipeline();
    jobIds.forEach((id) => pipeline.get(buildJobKey(id)));
    const results = await pipeline.exec(); // ← This was missing!

    const now = Date.now();
    const deletePipeline = redis.pipeline();
    let deletedCount = 0;

    for (let i = 0; i < results.length; i++) {
      const raw = results[i][1];
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);
        const status = data?.order_payload?.status;
        const rejectedAt = data?.order_payload?.rejected_at;

        if (status !== "REJECTED" || !rejectedAt) continue;

        const rejectedTime = new Date(rejectedAt).getTime();
        const ageMinutes = (now - rejectedTime) / (1000 * 60);

        console.log(
          `⏰ Order ${data.job_id} rejected ${ageMinutes.toFixed(1)} minutes ago`,
        );

        if (now - rejectedTime >= THIRTY_MIN_MS) {
          const jobId = data.job_id;
          deletePipeline
            .del(buildJobKey(jobId))
            .zrem(ZSET_KEY, jobId)
            .del(buildLockKey(jobId))
            .del(buildAttemptsKey(jobId))
            .del(buildErrorKey(jobId));

          deletedCount++;
          console.log(
            `🗑 DELETING ${jobId} (age: ${ageMinutes.toFixed(1)} mins)`,
          );
        } else {
          console.log(
            `⏳ Keeping ${data.job_id} (needs ${(30 - ageMinutes).toFixed(1)} more minutes)`,
          );
        }
      } catch (err) {
        console.error("❌ Failed parsing scheduled order:", err);
      }
    }

    if (deletePipeline.length > 0) {
      await deletePipeline.exec();
      console.log(
        `✅ Cleanup complete. Deleted ${deletedCount} expired rejected orders.`,
      );
    } else {
      console.log(`✅ Cleanup complete. No expired rejected orders found.`);
    }
  } catch (err) {
    console.error("❌ Cleanup service error:", err);
  }
}

module.exports = {
  cleanupRejectedScheduledOrders,
};
