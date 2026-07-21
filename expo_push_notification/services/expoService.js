const { Expo } = require("expo-server-sdk");

const expoClient = new Expo();

function isExpoToken(t) {
  return typeof t === "string" && Expo.isExpoPushToken(t);
}

const MIXED_PROJECT_ERROR = /same project/i;

// Sends one chunk. If Expo rejects it because the tokens span multiple
// Expo/EAS projects (its batch endpoint requires a single project per
// request), falls back to sending each message individually so a project
// mismatch degrades to slower delivery instead of failing the whole chunk.
async function sendChunkWithFallback(chunk) {
  try {
    return await expoClient.sendPushNotificationsAsync(chunk);
  } catch (error) {
    if (chunk.length > 1 && MIXED_PROJECT_ERROR.test(error?.message || "")) {
      console.warn(
        `⚠️ Mixed-project batch (${chunk.length} messages) — falling back to individual sends.`,
      );
      const tickets = [];
      for (const message of chunk) {
        try {
          const [ticket] = await expoClient.sendPushNotificationsAsync([message]);
          tickets.push(ticket);
        } catch (singleError) {
          tickets.push({ status: "error", message: singleError.message });
        }
      }
      return tickets;
    }
    throw error;
  }
}

// Sends messages via Expo's real batch endpoint (up to 100 messages per HTTP
// call, handled by chunkPushNotifications) instead of one HTTP request per
// message. Keeps the same return shape callers already rely on:
// { success, results: [{ to, ok, status }], total_messages, success_count, failure_count }
async function sendPushMessages(messages) {
  if (!messages || messages.length === 0) {
    return { success: false, error: "No messages to send" };
  }

  const chunks = expoClient.chunkPushNotifications(messages);
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  console.log(
    `📤 Sending ${messages.length} notifications in ${chunks.length} batch(es)...`,
  );

  for (const chunk of chunks) {
    try {
      const tickets = await sendChunkWithFallback(chunk);

      tickets.forEach((ticket, idx) => {
        const to = chunk[idx]?.to;
        const ok = ticket.status === "ok";

        if (ok) {
          successCount++;
        } else {
          failureCount++;
        }

        results.push({ to, ok, response: ticket });
      });

      console.log(
        `✅ Batch of ${chunk.length} sent (${tickets.filter((t) => t.status === "ok").length} ok)`,
      );
    } catch (error) {
      console.error("❌ Batch send error:", error.message);
      chunk.forEach((m) => {
        results.push({ to: m.to, ok: false, error: error.message });
        failureCount++;
      });
    }
  }

  console.log(`\n📊 Summary: ${successCount} sent, ${failureCount} failed`);

  return {
    success: failureCount === 0,
    results,
    total_messages: messages.length,
    success_count: successCount,
    failure_count: failureCount,
  };
}

module.exports = {
  isExpoToken,
  sendPushMessages,
};
