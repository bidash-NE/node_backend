const { prisma } = require("../lib/prisma.js");

const PUSH_SERVICE_URL = (
  process.env.PUSH_SERVICE_URL || "http://localhost:3007"
).replace(/\/+$/, "");

// Matches the expo_push_notification service's own cap on /send-bulk.
const PUSH_BULK_MAX = Number(process.env.PUSH_BULK_MAX || 100);

// Node 18+ has global fetch. If older node, uses node-fetch dynamically.
async function fetchAny(url, opts) {
  if (global.fetch) return global.fetch(url, opts);
  const { default: fetch } = await import("node-fetch");
  return fetch(url, opts);
}

/**
 * Resolves user_ids for the given roles, then sends Expo push notifications
 * via the expo_push_notification microservice, batching at its bulk-send cap.
 */
async function sendNotificationPush({ title, message, roles }) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return { total_target_users: 0, sent: 0, failed: 0, users_without_tokens: 0, errors: [] };
  }

  const users = await prisma.users.findMany({
    where: { role: { in: roles } },
    select: { user_id: true },
  });

  const userIds = users.map((u) => Number(u.user_id));
  if (!userIds.length) {
    return { total_target_users: 0, sent: 0, failed: 0, users_without_tokens: 0, errors: [] };
  }

  const batches = [];
  for (let i = 0; i < userIds.length; i += PUSH_BULK_MAX) {
    batches.push(userIds.slice(i, i + PUSH_BULK_MAX));
  }

  let sent = 0;
  let failed = 0;
  let usersWithoutTokens = 0;
  const errors = [];

  for (const batch of batches) {
    try {
      const res = await fetchAny(`${PUSH_SERVICE_URL}/api/push/send-bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids: batch, title, body: message }),
      });
      const json = await res.json().catch(() => null);

      if (res.ok && json?.data) {
        sent += Number(json.data.total_tokens_sent || 0);
        usersWithoutTokens += Number(json.data.users_without_tokens || 0);
      } else if (res.status === 404) {
        // No registered device tokens for anyone in this batch — not an error.
        usersWithoutTokens += batch.length;
      } else {
        failed += batch.length;
        errors.push(json?.message || `HTTP ${res.status}`);
      }
    } catch (e) {
      failed += batch.length;
      errors.push(e.message || String(e));
    }
  }

  return {
    total_target_users: userIds.length,
    sent,
    failed,
    users_without_tokens: usersWithoutTokens,
    errors: errors.slice(0, 5),
  };
}

module.exports = { sendNotificationPush };
