const crypto = require("crypto");
const { prisma } = require("../lib/prisma.js");
const expo = require("../services/expoService");

// In-memory tracker for role broadcast jobs (this service has no queue/redis
// infra yet). Jobs are cleaned up a day after they finish so the map doesn't
// grow unbounded; status is lost if the process restarts mid-broadcast.
const BROADCAST_JOBS = new Map();
const BROADCAST_BATCH_SIZE = 100;
const BROADCAST_JOB_TTL_MS = 24 * 60 * 60 * 1000;
// If any users fail on the first pass, the job automatically re-sends to
// just those users this many more times before giving up on them.
const BROADCAST_MAX_AUTO_RETRIES = 2;
const BROADCAST_RETRY_DELAY_MS = 2000;

function scheduleBroadcastJobCleanup(jobId) {
  const timer = setTimeout(() => BROADCAST_JOBS.delete(jobId), BROADCAST_JOB_TTL_MS);
  timer.unref?.();
}

function publicBroadcastJobView(job) {
  const { _internal, ...rest } = job;
  return rest;
}

// Helper function to convert BigInt to Number
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return value;
}

// Helper function for consistent error responses
function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

// Helper function for success responses
function successResponse(res, statusCode, message, data = null) {
  const response = { success: true, message };
  if (data) response.data = data;
  return res.status(statusCode).json(response);
}

// Helper function to validate and get unique IDs
function getValidUserIds(userIds) {
  if (!Array.isArray(userIds)) {
    userIds = [userIds];
  }

  const validIds = [];
  for (const id of userIds) {
    const num = Number(id);
    if (!isNaN(num) && Number.isInteger(num) && num > 0) {
      validIds.push(num);
    }
  }
  return [...new Set(validIds)];
}

// Helper function to fetch Expo tokens for users
async function fetchExpoTokensForUsers(userIds) {
  try {
    const validUserIds = getValidUserIds(userIds);

    if (validUserIds.length === 0) {
      return { tokens: [], tokensByUser: new Map() };
    }

    const deviceRecords = await prisma.all_device_ids.findMany({
      where: {
        user_id: {
          in: validUserIds,
        },
      },
      select: {
        user_id: true,
        device_id: true,
      },
    });

    const tokensByUser = new Map();
    const allTokens = [];

    for (const record of deviceRecords) {
      const userId = toNumber(record.user_id);
      const deviceId = record.device_id
        ? String(record.device_id).trim()
        : null;

      if (!deviceId) continue;

      if (!expo.isExpoToken(deviceId)) continue;

      if (!tokensByUser.has(userId)) {
        tokensByUser.set(userId, []);
      }
      tokensByUser.get(userId).push(deviceId);
      allTokens.push(deviceId);
    }

    const uniqueTokens = [...new Set(allTokens)];

    return {
      tokens: uniqueTokens,
      tokensByUser,
    };
  } catch (error) {
    console.error("Error fetching Expo tokens:", error);
    throw new Error("Unable to fetch push tokens. Please try again later.");
  }
}

// ===================== REGISTER PUSH TOKEN =====================
exports.registerToken = async (req, res) => {
  try {
    const { user_id, expo_token, device_id } = req.body || {};

    const userId = toNumber(user_id);
    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    if (!expo_token || typeof expo_token !== "string" || !expo_token.trim()) {
      return errorResponse(res, 400, "Expo push token is required.");
    }

    const trimmedToken = expo_token.trim();

    if (!expo.isExpoToken(trimmedToken)) {
      return errorResponse(
        res,
        400,
        "Invalid Expo push token format. Please make sure you're using a valid Expo token.",
      );
    }

    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true, is_active: true },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "User not found. Please check the user ID.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Cannot register push token for deactivated account. Please contact support.",
      );
    }

    await prisma.all_device_ids.upsert({
      where: { user_id: userId },
      update: {
        device_id: trimmedToken,
        last_seen: new Date(),
      },
      create: {
        user_id: userId,
        device_id: trimmedToken,
        last_seen: new Date(),
      },
    });

    return successResponse(res, 200, "Push token registered successfully.", {
      user_id: userId,
      expo_token: trimmedToken,
    });
  } catch (error) {
    console.error("Register token error:", error);
    return errorResponse(
      res,
      500,
      "Unable to register push token. Please try again later.",
    );
  }
};

// ===================== REMOVE PUSH TOKEN =====================
exports.removeToken = async (req, res) => {
  try {
    const { user_id, expo_token } = req.body || {};

    const userId = toNumber(user_id);
    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    if (!expo_token || typeof expo_token !== "string" || !expo_token.trim()) {
      return errorResponse(res, 400, "Expo push token is required.");
    }

    const trimmedToken = expo_token.trim();

    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: { user_id: userId },
      select: { device_id: true },
    });

    if (!deviceRecord) {
      return errorResponse(res, 404, "No push token found for this user.");
    }

    if (deviceRecord.device_id === trimmedToken) {
      await prisma.all_device_ids.delete({
        where: { user_id: userId },
      });
      return successResponse(res, 200, "Push token removed successfully.");
    } else {
      return successResponse(res, 200, "Push token already removed.");
    }
  } catch (error) {
    console.error("Remove token error:", error);
    if (error.code === "P2025") {
      return errorResponse(res, 404, "No push token found for this user.");
    }
    return errorResponse(
      res,
      500,
      "Unable to remove push token. Please try again later.",
    );
  }
};

// ===================== GET USER TOKENS =====================
exports.getUserTokens = async (req, res) => {
  try {
    const { user_id } = req.params;
    const userId = toNumber(user_id);

    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: { user_id: userId },
      select: { device_id: true, last_seen: true },
    });

    if (!deviceRecord || !deviceRecord.device_id) {
      return successResponse(res, 200, "No push tokens found for this user.", {
        user_id: userId,
        tokens: [],
      });
    }

    const token = deviceRecord.device_id;
    const isValid = expo.isExpoToken(token);

    return successResponse(res, 200, "Push tokens retrieved successfully.", {
      user_id: userId,
      tokens: [token],
      is_valid_token: isValid,
      last_seen: deviceRecord.last_seen,
    });
  } catch (error) {
    console.error("Get user tokens error:", error);
    return errorResponse(
      res,
      500,
      "Unable to retrieve push tokens. Please try again later.",
    );
  }
};

// ===================== SEND PUSH NOTIFICATION TO SINGLE USER =====================
exports.sendToUser = async (req, res) => {
  try {
    const {
      user_id,
      title = "Notification",
      body = "",
      data = {},
    } = req.body || {};

    const userId = toNumber(user_id);
    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    if (!title || typeof title !== "string" || !title.trim()) {
      return errorResponse(res, 400, "Notification title is required.");
    }

    if (!body || typeof body !== "string") {
      return errorResponse(res, 400, "Notification body is required.");
    }

    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true, is_active: true, is_verified: true },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "User not found. Please check the user ID.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Cannot send notification to deactivated account.",
      );
    }

    const { tokens } = await fetchExpoTokensForUsers([userId]);

    if (!tokens.length) {
      return errorResponse(
        res,
        404,
        "No push token found for this user. Please ask the user to register their device.",
      );
    }

    const messages = tokens.map((to) => ({
      to,
      title: title.trim(),
      body: body.trim(),
      data: data || {},
      sound: "default",
      priority: "high",
    }));

    const result = await expo.sendPushMessages(messages);

    try {
      await prisma.notification_logs.create({
        data: {
          user_id: userId,
          title: title.trim(),
          body: body.trim(),
          data: data || {},
          status: result.success ? "sent" : "failed",
          sent_at: new Date(),
        },
      });
    } catch (logError) {
      console.error("Failed to log notification:", logError);
    }

    return successResponse(res, 200, "Push notification sent successfully.", {
      user_id: userId,
      tokens_sent: tokens.length,
      result,
    });
  } catch (error) {
    console.error("Send notification error:", error);
    return errorResponse(
      res,
      500,
      "Unable to send push notification. Please try again later.",
    );
  }
};

// ===================== SEND BULK PUSH NOTIFICATION =====================
exports.sendBulkToUsers = async (req, res) => {
  try {
    const {
      user_ids,
      title = "Notification",
      body = "",
      data = {},
    } = req.body || {};

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return errorResponse(res, 400, "Please provide an array of user IDs.");
    }

    if (user_ids.length > 100) {
      return errorResponse(
        res,
        400,
        "Cannot send bulk notifications to more than 100 users at once.",
      );
    }

    if (!title || typeof title !== "string" || !title.trim()) {
      return errorResponse(res, 400, "Notification title is required.");
    }

    if (!body || typeof body !== "string") {
      return errorResponse(res, 400, "Notification body is required.");
    }

    const validUserIds = getValidUserIds(user_ids);

    if (validUserIds.length === 0) {
      return errorResponse(
        res,
        400,
        "Please provide valid user IDs (positive integers).",
      );
    }

    const { tokens, tokensByUser } =
      await fetchExpoTokensForUsers(validUserIds);

    if (!tokens.length) {
      return errorResponse(
        res,
        404,
        "No push tokens found for the provided users.",
      );
    }

    const messages = tokens.map((to) => ({
      to,
      title: title.trim(),
      body: body.trim(),
      data: data || {},
      sound: "default",
      priority: "high",
    }));

    const result = await expo.sendPushMessages(messages);

    const usersWithTokens = Array.from(tokensByUser.keys());
    const usersWithoutTokens = validUserIds.filter(
      (id) => !usersWithTokens.includes(id),
    );

    // ✅ Check if notification_logs table exists before logging
    try {
      // Check if the model exists in prisma
      if (prisma.notification_logs) {
        const notificationPromises = usersWithTokens.map((userId) =>
          prisma.notification_logs.create({
            data: {
              user_id: userId,
              title: title.trim(),
              body: body.trim(),
              data: data || {},
              status: result.success ? "sent" : "failed",
              sent_at: new Date(),
            },
          }),
        );
        await Promise.all(notificationPromises);
      } else {
        console.log("⚠️ notification_logs table not found, skipping log");
      }
    } catch (logError) {
      console.error("Failed to log bulk notifications:", logError.message);
    }

    return successResponse(
      res,
      200,
      "Bulk push notifications sent successfully.",
      {
        total_requested: validUserIds.length,
        users_with_tokens: usersWithTokens.length,
        users_without_tokens: usersWithoutTokens.length,
        users_without_tokens_list: usersWithoutTokens,
        total_tokens_sent: tokens.length,
        result,
      },
    );
  } catch (error) {
    console.error("Send bulk notification error:", error);
    return errorResponse(
      res,
      500,
      "Unable to send bulk push notifications. Please try again later.",
    );
  }
};

// Also fix the sendToUser function
exports.sendToUser = async (req, res) => {
  try {
    const {
      user_id,
      title = "Notification",
      body = "",
      data = {},
    } = req.body || {};

    const userId = toNumber(user_id);
    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    if (!title || typeof title !== "string" || !title.trim()) {
      return errorResponse(res, 400, "Notification title is required.");
    }

    if (!body || typeof body !== "string") {
      return errorResponse(res, 400, "Notification body is required.");
    }

    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true, is_active: true, is_verified: true },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "User not found. Please check the user ID.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Cannot send notification to deactivated account.",
      );
    }

    const { tokens } = await fetchExpoTokensForUsers([userId]);

    if (!tokens.length) {
      return errorResponse(
        res,
        404,
        "No push token found for this user. Please ask the user to register their device.",
      );
    }

    const messages = tokens.map((to) => ({
      to,
      title: title.trim(),
      body: body.trim(),
      data: data || {},
      sound: "default",
      priority: "high",
    }));

    const result = await expo.sendPushMessages(messages);

    // ✅ Check if notification_logs table exists before logging
    try {
      if (prisma.notification_logs) {
        await prisma.notification_logs.create({
          data: {
            user_id: userId,
            title: title.trim(),
            body: body.trim(),
            data: data || {},
            status: result.success ? "sent" : "failed",
            sent_at: new Date(),
          },
        });
      }
    } catch (logError) {
      console.error("Failed to log notification:", logError.message);
    }

    return successResponse(res, 200, "Push notification sent successfully.", {
      user_id: userId,
      tokens_sent: tokens.length,
      result,
    });
  } catch (error) {
    console.error("Send notification error:", error);
    return errorResponse(
      res,
      500,
      "Unable to send push notification. Please try again later.",
    );
  }
};

// ===================== GET NOTIFICATION HISTORY =====================
exports.getNotificationHistory = async (req, res) => {
  try {
    const { user_id } = req.params;
    const userId = toNumber(user_id);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    if (!userId || userId <= 0) {
      return errorResponse(res, 400, "Valid user ID is required.");
    }

    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true },
    });

    if (!user) {
      return errorResponse(res, 404, "User not found.");
    }

    const [notifications, total] = await Promise.all([
      prisma.notification_logs.findMany({
        where: { user_id: userId },
        orderBy: { sent_at: "desc" },
        take: limit,
        skip: skip,
        select: {
          id: true,
          title: true,
          body: true,
          data: true,
          status: true,
          sent_at: true,
        },
      }),
      prisma.notification_logs.count({
        where: { user_id: userId },
      }),
    ]);

    return successResponse(
      res,
      200,
      "Notification history retrieved successfully.",
      {
        user_id: userId,
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
        notifications,
      },
    );
  } catch (error) {
    console.error("Get notification history error:", error);
    return errorResponse(
      res,
      500,
      "Unable to retrieve notification history. Please try again later.",
    );
  }
};

// ===================== BROADCAST TO ALL USERS OF A ROLE =====================

// Sends one round of messages to `userIds`, updates job counters, and
// returns the list of user_ids that failed in this round (retryable).
// `trackProgress` should only be true for the initial pass, so processed_users
// doesn't double-count users across auto-retry rounds.
async function sendBroadcastRound(jobId, userIds, trackProgress) {
  const job = BROADCAST_JOBS.get(jobId);
  const { title, body, data } = job._internal;
  const failedUserIds = [];

  for (let i = 0; i < userIds.length; i += BROADCAST_BATCH_SIZE) {
    const batch = userIds.slice(i, i + BROADCAST_BATCH_SIZE);

    try {
      const { tokens, tokensByUser } = await fetchExpoTokensForUsers(batch);
      const usersWithTokens = Array.from(tokensByUser.keys());
      const usersWithoutTokens = batch.filter(
        (id) => !usersWithTokens.includes(id),
      );
      // No token registered at all — retrying won't help until the user's
      // device re-registers, so these are excluded from failedUserIds.
      job.users_without_tokens += usersWithoutTokens.length;
      job.users_without_tokens_ids.push(...usersWithoutTokens);

      if (tokens.length) {
        const messages = tokens.map((to) => ({
          to,
          title,
          body,
          data: data || {},
          sound: "default",
          priority: "high",
        }));

        const result = await expo.sendPushMessages(messages);
        job.tokens_sent += result.success_count || 0;
        job.tokens_failed += result.failure_count || 0;

        // Map each token back to its own delivery outcome instead of
        // stamping every user in the batch with the same aggregate status.
        const tokenOk = new Map();
        for (const r of result.results || []) {
          tokenOk.set(r.to, !!r.ok);
        }

        const userLogEntries = [];
        for (const [userId, userTokens] of tokensByUser.entries()) {
          const allOk = userTokens.every((t) => tokenOk.get(t) === true);
          userLogEntries.push({ userId, status: allOk ? "sent" : "failed" });
          if (!allOk) failedUserIds.push(userId);
        }

        try {
          if (prisma.notification_logs) {
            await Promise.all(
              userLogEntries.map(({ userId, status }) =>
                prisma.notification_logs.create({
                  data: {
                    user_id: userId,
                    title,
                    body,
                    data: JSON.stringify(data || {}),
                    status,
                    sent_at: new Date(),
                  },
                }),
              ),
            );
          }
        } catch (logError) {
          console.error(
            `[broadcast:${jobId}] failed to log batch:`,
            logError.message,
          );
        }
      }
    } catch (batchError) {
      console.error(`[broadcast:${jobId}] batch error:`, batchError);
      job.errors.push(batchError.message || String(batchError));
      // We don't know per-user outcome when the batch itself throws
      // (e.g. token lookup failed) — mark everyone in it as failed so
      // they're eligible for the next auto-retry round rather than dropped.
      failedUserIds.push(...batch);
    }

    if (trackProgress) job.processed_users += batch.length;
  }

  return failedUserIds;
}

async function processBroadcastJob(jobId) {
  const job = BROADCAST_JOBS.get(jobId);
  if (!job) return;

  try {
    let pending = job._internal.userIds;
    let attempt = 0;

    while (pending.length && attempt <= BROADCAST_MAX_AUTO_RETRIES) {
      if (attempt > 0) {
        job.retry_attempts = attempt;
        await new Promise((r) => setTimeout(r, BROADCAST_RETRY_DELAY_MS));
      }

      pending = await sendBroadcastRound(jobId, pending, attempt === 0);
      job.failed_user_ids = pending;
      attempt++;
    }

    job.status = "completed";
  } catch (error) {
    console.error(`[broadcast:${jobId}] fatal error:`, error);
    job.status = "failed";
    job.errors.push(error.message || String(error));
  } finally {
    job.completed_at = new Date().toISOString();
    scheduleBroadcastJobCleanup(jobId);
  }
}

function makeBroadcastHandler(role, label) {
  return async function broadcastHandler(req, res) {
    try {
      const { title, body, data = {} } = req.body || {};

      if (!title || typeof title !== "string" || !title.trim()) {
        return errorResponse(res, 400, "Notification title is required.");
      }

      if (!body || typeof body !== "string" || !body.trim()) {
        return errorResponse(res, 400, "Notification body is required.");
      }

      const users = await prisma.users.findMany({
        where: { role },
        select: { user_id: true },
      });
      const userIds = users.map((u) => toNumber(u.user_id));

      const jobId = crypto.randomUUID();
      const job = {
        job_id: jobId,
        role,
        title: title.trim(),
        body: body.trim(),
        status: "processing",
        total_target_users: userIds.length,
        processed_users: 0,
        tokens_sent: 0,
        tokens_failed: 0,
        users_without_tokens: 0,
        users_without_tokens_ids: [],
        failed_user_ids: [],
        retry_attempts: 0,
        errors: [],
        created_at: new Date().toISOString(),
        completed_at: null,
        _internal: { userIds, title: title.trim(), body: body.trim(), data },
      };
      BROADCAST_JOBS.set(jobId, job);

      if (userIds.length === 0) {
        job.status = "completed";
        job.completed_at = new Date().toISOString();
        scheduleBroadcastJobCleanup(jobId);
      } else {
        setImmediate(() => processBroadcastJob(jobId));
      }

      return successResponse(
        res,
        202,
        `Broadcast to all ${label} queued.`,
        publicBroadcastJobView(job),
      );
    } catch (error) {
      console.error(`Broadcast to ${label} error:`, error);
      return errorResponse(
        res,
        500,
        "Unable to start broadcast. Please try again later.",
      );
    }
  };
}

// ✅ Broadcast to all users with role = "user"
exports.broadcastToUsers = makeBroadcastHandler("user", "users");

// ✅ Broadcast to all users with role = "merchant"
exports.broadcastToMerchants = makeBroadcastHandler("merchant", "merchants");

// ✅ Broadcast to all users with role = "driver"
exports.broadcastToDrivers = makeBroadcastHandler("driver", "drivers");

// ===================== GET BROADCAST JOB STATUS =====================
exports.getBroadcastStatus = async (req, res) => {
  const { job_id } = req.params;
  const job = BROADCAST_JOBS.get(job_id);

  if (!job) {
    return errorResponse(res, 404, "Broadcast job not found.");
  }

  return successResponse(
    res,
    200,
    "Broadcast job status retrieved.",
    publicBroadcastJobView(job),
  );
};

// ===================== RETRY FAILED USERS FROM A BROADCAST JOB =====================
exports.retryBroadcastFailures = async (req, res) => {
  const { job_id } = req.params;
  const original = BROADCAST_JOBS.get(job_id);

  if (!original) {
    return errorResponse(res, 404, "Broadcast job not found.");
  }

  if (original.status === "processing") {
    return errorResponse(
      res,
      409,
      "Original broadcast is still processing. Try again once it completes.",
    );
  }

  const retryUserIds = [...new Set(original.failed_user_ids)];

  if (!retryUserIds.length) {
    return errorResponse(
      res,
      400,
      "No failed users to retry for this job. (Users without a registered token are excluded — retrying won't help until they register one.)",
    );
  }

  const jobId = crypto.randomUUID();
  const job = {
    job_id: jobId,
    role: original.role,
    retry_of: original.job_id,
    title: original.title,
    body: original.body,
    status: "processing",
    total_target_users: retryUserIds.length,
    processed_users: 0,
    tokens_sent: 0,
    tokens_failed: 0,
    users_without_tokens: 0,
    users_without_tokens_ids: [],
    failed_user_ids: [],
    retry_attempts: 0,
    errors: [],
    created_at: new Date().toISOString(),
    completed_at: null,
    _internal: {
      userIds: retryUserIds,
      title: original.title,
      body: original.body,
      data: original._internal?.data || {},
    },
  };
  BROADCAST_JOBS.set(jobId, job);

  setImmediate(() => processBroadcastJob(jobId));

  return successResponse(
    res,
    202,
    `Retry broadcast queued for ${retryUserIds.length} previously failed user(s).`,
    publicBroadcastJobView(job),
  );
};
