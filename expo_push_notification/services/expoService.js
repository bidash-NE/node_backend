const fetch = require("node-fetch");

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";

function isExpoToken(t) {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

async function sendPushMessages(messages) {
  if (!messages || messages.length === 0) {
    return { success: false, error: "No messages to send" };
  }

  const results = [];
  let successCount = 0;
  let failureCount = 0;
  let successTokens = [];
  let failedTokens = [];

  console.log(`📤 Sending ${messages.length} notifications individually...`);

  // Send each message one by one to avoid project mixing
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    try {
      const response = await fetch(EXPO_SEND_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      const json = await response.json();

      const result = {
        to: message.to,
        status: response.status,
        ok: response.ok,
        response: json,
      };

      results.push(result);

      if (response.ok) {
        successCount++;
        successTokens.push(message.to);
        console.log(
          `✅ [${i + 1}/${messages.length}] Sent to: ${message.to.substring(0, 30)}...`,
        );
      } else {
        failureCount++;
        failedTokens.push(message.to);
        console.log(
          `❌ [${i + 1}/${messages.length}] Failed for: ${message.to.substring(0, 30)}...`,
        );
        if (json.errors) {
          console.log(
            `   Error: ${json.errors[0]?.message || "Unknown error"}`,
          );
        }
      }

      // Small delay to avoid rate limiting (50ms between messages)
      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.error(
        `❌ [${i + 1}/${messages.length}] Exception for: ${message.to?.substring(0, 30)}...`,
      );
      console.error(`   Error: ${error.message}`);

      results.push({
        to: message.to,
        ok: false,
        error: error.message,
      });
      failureCount++;
      failedTokens.push(message.to);
    }
  }

  console.log(`\n📊 Summary: ${successCount} sent, ${failureCount} failed`);

  return {
    success: failureCount === 0,
    results,
    total_messages: messages.length,
    success_count: successCount,
    failure_count: failureCount,
    success_tokens: successTokens,
    failed_tokens: failedTokens,
  };
}

module.exports = {
  isExpoToken,
  sendPushMessages,
};
