const fetch = require("node-fetch");

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

function isExpoToken(t) {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

// Expo recommends chunking messages. Keep it simple but safe:
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendPushMessages(messages) {
  // chunk to avoid huge payloads
  const chunks = chunkArray(messages, 100);

  const allTickets = [];
  for (const chunk of chunks) {
    const r = await fetch(EXPO_SEND_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chunk.length === 1 ? chunk[0] : chunk),
    });

    const json = await r.json();
    allTickets.push(json);
  }

  return allTickets;
}

async function getReceipts(receiptIds) {
  const r = await fetch(EXPO_RECEIPTS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: receiptIds }),
  });
  return r.json();
}

module.exports = { isExpoToken, sendPushMessages, getReceipts };
