const fetch = require("node-fetch");

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";

function isExpoToken(t) {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendPushMessages(messages) {
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

    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: "Invalid JSON from Expo", raw: text };
    }

    allTickets.push({ status: r.status, ok: r.ok, response: json });
  }

  return allTickets;
}

module.exports = { isExpoToken, sendPushMessages };
