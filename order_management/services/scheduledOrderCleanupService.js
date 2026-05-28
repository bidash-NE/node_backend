// services/scheduledOrderCleanup.js

const redis = require("../config/redis");
const db = require("../config/db");

const {
  ZSET_KEY, // legacy old mixed queue
  PENDING_ZSET_KEY,
  ACCEPTED_ZSET_KEY,
  REJECTED_ZSET_KEY,
  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
  buildErrorKey,
} = require("../models/scheduledOrderModel");

const THIRTY_MIN_MS = 30 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * Get merchant user_id from business_id.
 *
 * IMPORTANT:
 * This assumes merchant_business_details has user_id.
 * If your column is merchant_id, owner_id, created_by, etc.,
 * update the SELECT column below.
 */
async function getMerchantUserIdByBusinessId(businessId) {
  if (!businessId) return null;

  try {
    const [rows] = await db.query(
      `
        SELECT user_id
          FROM merchant_business_details
         WHERE business_id = ?
         LIMIT 1
      `,
      [businessId],
    );

    const merchantUserId = rows?.[0]?.user_id;
    return merchantUserId ? Number(merchantUserId) : null;
  } catch (err) {
    console.error(
      `[SCHED-CLEANUP] Failed to fetch merchant user_id for business_id ${businessId}:`,
      err.message,
    );
    return null;
  }
}

async function sendPushNotificationSafe({ user_id, title, body }) {
  if (!user_id) return;

  try {
    const {
      sendUserNotification,
    } = require("../services/expoNotificationService");

    await sendUserNotification({
      user_id,
      title,
      body,
    });
  } catch (err) {
    console.error(
      `[SCHED-CLEANUP] Push notification failed for user_id ${user_id}:`,
      err.message,
    );
  }
}

async function insertDbNotificationSafe({ user_id, title, message, data }) {
  if (!user_id) return;

  try {
    await db.query(
      `
        INSERT INTO notifications
          (user_id, type, title, message, data, status, created_at)
        VALUES
          (?, ?, ?, ?, ?, 'unread', NOW())
      `,
      [
        user_id,
        "order_status",
        title,
        message,
        JSON.stringify(data || {}),
      ],
    );
  } catch (err) {
    console.error(
      `[SCHED-CLEANUP] DB notification failed for user_id ${user_id}:`,
      err.message,
    );
  }
}

async function notifyUserAndMerchant({
  data,
  jobId,
  status,
  reason,
  userTitle,
  userMessage,
  merchantTitle,
  merchantMessage,
}) {
  const customerUserId = Number(data?.user_id || data?.order_payload?.user_id);
  const businessId =
    data?.business_id ||
    data?.order_payload?.business_id ||
    data?.order_payload?.items?.[0]?.business_id ||
    null;

  const merchantUserId = await getMerchantUserIdByBusinessId(businessId);

  const baseNotificationData = {
    job_id: jobId,
    status,
    reason,
    business_id: businessId,
    scheduled_at: data?.scheduled_at_local || data?.scheduled_at || null,
  };

  // Customer notification
  await sendPushNotificationSafe({
    user_id: customerUserId,
    title: userTitle,
    body: userMessage,
  });

  await insertDbNotificationSafe({
    user_id: customerUserId,
    title: userTitle,
    message: userMessage,
    data: {
      ...baseNotificationData,
      recipient_type: "customer",
    },
  });

  // Merchant notification through merchant user_id
  await sendPushNotificationSafe({
    user_id: merchantUserId,
    title: merchantTitle,
    body: merchantMessage,
  });

  await insertDbNotificationSafe({
    user_id: merchantUserId,
    title: merchantTitle,
    message: merchantMessage,
    data: {
      ...baseNotificationData,
      recipient_type: "merchant",
      customer_user_id: customerUserId,
    },
  });
}

function getBusinessIdFromData(data) {
  return (
    data?.business_id ||
    data?.order_payload?.business_id ||
    data?.order_payload?.businessId ||
    data?.order_payload?.items?.[0]?.business_id ||
    data?.order_payload?.items?.[0]?.businessId ||
    null
  );
}

async function deleteScheduledJob(deletePipeline, jobId) {
  deletePipeline
    .del(buildJobKey(jobId))
    .zrem(PENDING_ZSET_KEY, jobId)
    .zrem(ACCEPTED_ZSET_KEY, jobId)
    .zrem(REJECTED_ZSET_KEY, jobId)
    .zrem(ZSET_KEY, jobId) // legacy queue cleanup
    .del(buildLockKey(jobId))
    .del(buildAttemptsKey(jobId))
    .del(buildErrorKey(jobId));
}

/**
 * Deletes pending scheduled orders after 30 minutes if merchant does nothing.
 *
 * New design:
 * scheduled_orders_pending score = created_at + 30 minutes
 */
async function cleanupPendingScheduledOrders() {
  try {
    console.log("🧹 Running pending scheduled order cleanup...");

    const now = Date.now();

    const jobIds = await redis.zrangebyscore(
      PENDING_ZSET_KEY,
      0,
      now,
      "LIMIT",
      0,
      BATCH_SIZE,
    );

    console.log(`📊 Found ${jobIds.length} expired pending orders`);

    if (!jobIds.length) return;

    const pipeline = redis.pipeline();
    jobIds.forEach((id) => pipeline.get(buildJobKey(id)));

    const results = await pipeline.exec();

    const deletePipeline = redis.pipeline();
    let deletedCount = 0;
    let movedAcceptedCount = 0;
    let movedRejectedCount = 0;

    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      const raw = results[i]?.[1];

      if (!raw) {
        deletePipeline.zrem(PENDING_ZSET_KEY, jobId);
        continue;
      }

      try {
        const data = JSON.parse(raw);
        const status = data?.order_payload?.status || "PENDING";

        const businessId = getBusinessIdFromData(data);
        if (businessId && !data.business_id) {
          data.business_id = Number(businessId);
        }

        // Safety: if accepted but still found in pending queue, move it.
        if (status === "ACCEPTED") {
          const scheduledScore = Number(data.scheduled_epoch_ms);

          if (Number.isFinite(scheduledScore)) {
            deletePipeline
              .set(buildJobKey(jobId), JSON.stringify(data))
              .zrem(PENDING_ZSET_KEY, jobId)
              .zrem(REJECTED_ZSET_KEY, jobId)
              .zrem(ZSET_KEY, jobId)
              .zadd(ACCEPTED_ZSET_KEY, scheduledScore, jobId);

            movedAcceptedCount++;
            console.log(
              `↪️ Moved ${jobId} from PENDING queue to ACCEPTED queue`,
            );
          } else {
            deletePipeline.zrem(PENDING_ZSET_KEY, jobId);
          }

          continue;
        }

        // Safety: if rejected but still found in pending queue, move it.
        if (status === "REJECTED") {
          const rejectedAt = data?.order_payload?.rejected_at;
          const rejectedTime = rejectedAt
            ? new Date(rejectedAt).getTime()
            : now;

          const deleteAtMs = Number.isFinite(rejectedTime)
            ? rejectedTime + THIRTY_MIN_MS
            : now + THIRTY_MIN_MS;

          deletePipeline
            .set(buildJobKey(jobId), JSON.stringify(data))
            .zrem(PENDING_ZSET_KEY, jobId)
            .zrem(ACCEPTED_ZSET_KEY, jobId)
            .zrem(ZSET_KEY, jobId)
            .zadd(REJECTED_ZSET_KEY, deleteAtMs, jobId);

          movedRejectedCount++;
          console.log(
            `↪️ Moved ${jobId} from PENDING queue to REJECTED queue`,
          );

          continue;
        }

        if (status !== "PENDING") {
          deletePipeline.zrem(PENDING_ZSET_KEY, jobId);
          continue;
        }

        await notifyUserAndMerchant({
          data,
          jobId,
          status: "EXPIRED",
          reason: "Not accepted within 30 minutes",
          userTitle: "Scheduled Order Expired",
          userMessage:
            "Your scheduled order was not accepted by the business within 30 minutes and has been cancelled.",
          merchantTitle: "Scheduled Order Expired",
          merchantMessage:
            "A scheduled order expired because it was not accepted within 30 minutes.",
        });

        await deleteScheduledJob(deletePipeline, jobId);

        deletedCount++;
        console.log(`🗑 Deleted expired pending scheduled order ${jobId}`);
      } catch (err) {
        console.error(
          `❌ Failed parsing pending scheduled order ${jobId}:`,
          err.message,
        );
      }
    }

    await deletePipeline.exec();

    console.log(
      `✅ Pending cleanup complete. Deleted ${deletedCount}, moved accepted ${movedAcceptedCount}, moved rejected ${movedRejectedCount}.`,
    );
  } catch (err) {
    console.error("❌ Pending cleanup service error:", err);
  }
}

/**
 * Deletes rejected scheduled orders after 30 minutes.
 *
 * New design:
 * scheduled_orders_rejected score = rejected_at + 30 minutes
 */
async function cleanupRejectedScheduledOrders() {
  try {
    console.log("🧹 Running rejected scheduled order cleanup...");

    const now = Date.now();

    const jobIds = await redis.zrangebyscore(
      REJECTED_ZSET_KEY,
      0,
      now,
      "LIMIT",
      0,
      BATCH_SIZE,
    );

    console.log(`📊 Found ${jobIds.length} expired rejected orders`);

    if (!jobIds.length) return;

    const pipeline = redis.pipeline();
    jobIds.forEach((id) => pipeline.get(buildJobKey(id)));

    const results = await pipeline.exec();

    const deletePipeline = redis.pipeline();
    let deletedCount = 0;

    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      const raw = results[i]?.[1];

      if (!raw) {
        deletePipeline.zrem(REJECTED_ZSET_KEY, jobId);
        continue;
      }

      try {
        const data = JSON.parse(raw);
        const status = data?.order_payload?.status;
        const rejectedAt = data?.order_payload?.rejected_at;
        const rejectionReason =
          data?.order_payload?.rejection_reason || "Rejected by merchant";

        if (status !== "REJECTED") {
          deletePipeline.zrem(REJECTED_ZSET_KEY, jobId);
          continue;
        }

        const rejectedTime = rejectedAt ? new Date(rejectedAt).getTime() : now;
        const ageMinutes = (now - rejectedTime) / (1000 * 60);

        console.log(
          `⏰ Order ${jobId} rejected ${ageMinutes.toFixed(1)} minutes ago`,
        );

        await notifyUserAndMerchant({
          data,
          jobId,
          status: "REJECTED_REMOVED",
          reason: rejectionReason,
          userTitle: "Rejected Scheduled Order Removed",
          userMessage:
            "Your rejected scheduled order has been removed from the scheduled order list.",
          merchantTitle: "Rejected Scheduled Order Removed",
          merchantMessage:
            "A rejected scheduled order has been removed from your scheduled order list.",
        });

        await deleteScheduledJob(deletePipeline, jobId);

        deletedCount++;
        console.log(
          `🗑 Deleted rejected scheduled order ${jobId} age ${ageMinutes.toFixed(
            1,
          )} mins`,
        );
      } catch (err) {
        console.error(
          `❌ Failed parsing rejected scheduled order ${jobId}:`,
          err.message,
        );
      }
    }

    await deletePipeline.exec();

    console.log(
      `✅ Rejected cleanup complete. Deleted ${deletedCount} expired rejected orders.`,
    );
  } catch (err) {
    console.error("❌ Rejected cleanup service error:", err);
  }
}

/**
 * Optional legacy cleanup for old data still stuck in old scheduled_orders ZSET.
 * This prevents old mixed queue records from staying forever.
 */
async function cleanupLegacyRejectedAndPendingScheduledOrders() {
  try {
    console.log("🧹 Running legacy scheduled order cleanup...");

    const jobIds = await redis.zrange(ZSET_KEY, 0, -1);
    console.log(`📊 Found ${jobIds.length} legacy orders in ZSET`);

    if (!jobIds.length) return;

    const pipeline = redis.pipeline();
    jobIds.forEach((id) => pipeline.get(buildJobKey(id)));

    const results = await pipeline.exec();

    const now = Date.now();
    const deletePipeline = redis.pipeline();

    let deletedPendingCount = 0;
    let deletedRejectedCount = 0;
    let movedAcceptedCount = 0;

    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i];
      const raw = results[i]?.[1];

      if (!raw) {
        deletePipeline.zrem(ZSET_KEY, jobId);
        continue;
      }

      try {
        const data = JSON.parse(raw);
        const status = data?.order_payload?.status || "PENDING";

        if (status === "ACCEPTED") {
          const scheduledScore = Number(data.scheduled_epoch_ms);

          if (Number.isFinite(scheduledScore)) {
            deletePipeline
              .zrem(ZSET_KEY, jobId)
              .zrem(PENDING_ZSET_KEY, jobId)
              .zrem(REJECTED_ZSET_KEY, jobId)
              .zadd(ACCEPTED_ZSET_KEY, scheduledScore, jobId);

            movedAcceptedCount++;
          }

          continue;
        }

        if (status === "REJECTED") {
          const rejectedAt = data?.order_payload?.rejected_at;
          const rejectedTime = rejectedAt ? new Date(rejectedAt).getTime() : now;

          if (now - rejectedTime >= THIRTY_MIN_MS) {
            await notifyUserAndMerchant({
              data,
              jobId,
              status: "REJECTED_REMOVED",
              reason:
                data?.order_payload?.rejection_reason ||
                "Rejected by merchant",
              userTitle: "Rejected Scheduled Order Removed",
              userMessage:
                "Your rejected scheduled order has been removed from the scheduled order list.",
              merchantTitle: "Rejected Scheduled Order Removed",
              merchantMessage:
                "A rejected scheduled order has been removed from your scheduled order list.",
            });

            await deleteScheduledJob(deletePipeline, jobId);
            deletedRejectedCount++;
          } else {
            deletePipeline
              .zrem(ZSET_KEY, jobId)
              .zadd(REJECTED_ZSET_KEY, rejectedTime + THIRTY_MIN_MS, jobId);
          }

          continue;
        }

        if (status === "PENDING") {
          const createdAt = data?.created_at;
          const createdTime = createdAt ? new Date(createdAt).getTime() : now;

          if (now - createdTime >= THIRTY_MIN_MS) {
            await notifyUserAndMerchant({
              data,
              jobId,
              status: "EXPIRED",
              reason: "Not accepted within 30 minutes",
              userTitle: "Scheduled Order Expired",
              userMessage:
                "Your scheduled order was not accepted by the business within 30 minutes and has been cancelled.",
              merchantTitle: "Scheduled Order Expired",
              merchantMessage:
                "A scheduled order expired because it was not accepted within 30 minutes.",
            });

            await deleteScheduledJob(deletePipeline, jobId);
            deletedPendingCount++;
          } else {
            deletePipeline
              .zrem(ZSET_KEY, jobId)
              .zadd(PENDING_ZSET_KEY, createdTime + THIRTY_MIN_MS, jobId);
          }

          continue;
        }

        deletePipeline.zrem(ZSET_KEY, jobId);
      } catch (err) {
        console.error(
          `❌ Failed parsing legacy scheduled order ${jobId}:`,
          err.message,
        );
      }
    }

    await deletePipeline.exec();

    console.log(
      `✅ Legacy cleanup complete. Deleted pending ${deletedPendingCount}, deleted rejected ${deletedRejectedCount}, moved accepted ${movedAcceptedCount}.`,
    );
  } catch (err) {
    console.error("❌ Legacy cleanup service error:", err);
  }
}

async function cleanupScheduledOrders() {
  await cleanupPendingScheduledOrders();
  await cleanupRejectedScheduledOrders();
  await cleanupLegacyRejectedAndPendingScheduledOrders();
}

module.exports = {
  cleanupScheduledOrders,
  cleanupPendingScheduledOrders,
  cleanupRejectedScheduledOrders,
  cleanupLegacyRejectedAndPendingScheduledOrders,
};