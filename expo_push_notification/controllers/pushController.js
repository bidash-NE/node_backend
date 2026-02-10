const db = require("../config/db");
const expo = require("../services/expoService");

function uniq(arr) {
  return [...new Set(arr)];
}

function toFinitePositiveInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

async function fetchExpoTokensForUsers(userIds) {
  const cleanIds = uniq(
    userIds.map(toFinitePositiveInt).filter((v) => v != null),
  );

  if (!cleanIds.length) return { tokens: [], tokensByUser: new Map() };

  const placeholders = cleanIds.map(() => "?").join(",");

  // Expect: all_device_ids(user_id, device_id)
  const [rows] = await db.query(
    `
    SELECT user_id, device_id
    FROM all_device_ids
    WHERE user_id IN (${placeholders})
    `,
    cleanIds,
  );

  const tokensByUser = new Map(); // user_id -> [token...]
  for (const r of rows) {
    const uid = Number(r.user_id);
    const token = String(r.device_id || "").trim();
    if (!expo.isExpoToken(token)) continue;

    if (!tokensByUser.has(uid)) tokensByUser.set(uid, []);
    tokensByUser.get(uid).push(token);
  }

  // flatten unique tokens (avoid duplicates across rows)
  const allTokens = uniq(
    Array.from(tokensByUser.values()).flat().filter(Boolean),
  );

  return { tokens: allTokens, tokensByUser };
}

// ------------------------------
// POST /api/push/send
// body: { user_id, title, body, data? }
// ------------------------------
exports.sendToUserFromDb = async (req, res) => {
  try {
    const {
      user_id,
      title = "Notification",
      body = "",
      data = {},
    } = req.body || {};

    const uid = toFinitePositiveInt(user_id);
    if (!uid) {
      return res.status(400).json({
        success: false,
        message: "Valid user_id is required",
      });
    }

    const { tokens } = await fetchExpoTokensForUsers([uid]);

    if (!tokens.length) {
      return res.status(404).json({
        success: false,
        message: "No Expo tokens found for this user",
      });
    }

    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      data,
      sound: "default",
    }));

    const result = await expo.sendPushMessages(messages);

    return res.json({
      success: true,
      user_id: uid,
      sent_to: tokens.length,
      result,
    });
  } catch (err) {
    console.error("[PUSH] sendToUserFromDb error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send notification",
    });
  }
};

// ------------------------------------
// POST /api/push/send-bulk
// body: {
//   "user_ids": [74, 75, 76],
//   "title": "...",
//   "body": "...",
//   "data": {...}
// }
// ------------------------------------
exports.sendBulkToUsersFromDb = async (req, res) => {
  try {
    const {
      user_ids,
      title = "Notification",
      body = "",
      data = {},
    } = req.body || {};

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "user_ids array is required",
      });
    }

    const cleanUserIds = uniq(
      user_ids.map(toFinitePositiveInt).filter((v) => v != null),
    );

    if (!cleanUserIds.length) {
      return res.status(400).json({
        success: false,
        message: "user_ids must contain valid positive numbers",
      });
    }

    const { tokens, tokensByUser } =
      await fetchExpoTokensForUsers(cleanUserIds);

    if (!tokens.length) {
      return res.status(404).json({
        success: false,
        message: "No Expo tokens found for provided users",
      });
    }

    // Build messages (one per token). Expo will handle batching (we chunk in service).
    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      data,
      sound: "default",
    }));

    const result = await expo.sendPushMessages(messages);

    // Helpful summary
    const foundUsers = Array.from(tokensByUser.keys());
    const notFoundUsers = cleanUserIds.filter((id) => !tokensByUser.has(id));

    return res.json({
      success: true,
      requested_users: cleanUserIds.length,
      users_with_tokens: foundUsers.length,
      users_without_tokens: notFoundUsers.length,
      users_without_tokens_list: notFoundUsers, // remove if you don't want to expose
      total_tokens_sent: tokens.length,
      result,
    });
  } catch (err) {
    console.error("[PUSH] sendBulkToUsersFromDb error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send bulk notification",
    });
  }
};
