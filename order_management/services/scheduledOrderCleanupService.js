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

    // get all scheduled jobs
    const jobIds = await redis.zrange(ZSET_KEY, 0, -1);
    if (!jobIds.length) return;

    // fetch all jobs
    const pipeline = redis.pipeline();
    jobIds.forEach((id) => pipeline.get(buildJobKey(id)));
    const results = await pipeline.exec();

    const now = Date.now();

    const deletePipeline = redis.pipeline();

    for (let i = 0; i < results.length; i++) {
      const raw = results[i][1];
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);

        const status = data?.order_payload?.status;
        const rejectedAt = data?.order_payload?.rejected_at;

        // ✅ only process rejected orders
        if (status !== "REJECTED" || !rejectedAt) continue;

        const rejectedTime = new Date(rejectedAt).getTime();

        // ✅ check 30 minutes passed
        if (now - rejectedTime >= THIRTY_MIN_MS) {
          const jobId = data.job_id;

          deletePipeline
            .del(buildJobKey(jobId))
            .zrem(ZSET_KEY, jobId)
            .del(buildLockKey(jobId))
            .del(buildAttemptsKey(jobId))
            .del(buildErrorKey(jobId));

          console.log(`🗑 Auto-deleted rejected order: ${jobId}`);
        }
      } catch (err) {
        console.error("❌ Failed parsing scheduled order:", err);
      }
    }

    await deletePipeline.exec();
  } catch (err) {
    console.error("❌ Cleanup service error:", err);
  }
}

module.exports = {
  cleanupRejectedScheduledOrders,
};
