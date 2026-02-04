const store = require("../store/tokenStore");
const expo = require("../services/expoService");

// POST /api/push/register
// body: { user_id, expo_push_token, device_id?, platform? }
exports.registerToken = async (req, res) => {
  const {
    user_id,
    expo_push_token,
    device_id = "",
    platform = "",
  } = req.body || {};

  if (!user_id) {
    return res
      .status(400)
      .json({ success: false, message: "user_id is required" });
  }
  if (!expo.isExpoToken(expo_push_token)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid expo_push_token" });
  }

  const saved = store.upsertToken({
    user_id: String(user_id),
    expo_push_token: String(expo_push_token),
    device_id: String(device_id || ""),
    platform: String(platform || ""),
  });

  return res.json({ success: true, message: "Token registered", data: saved });
};

// POST /api/push/unregister
// body: { user_id, expo_push_token }
exports.unregisterToken = async (req, res) => {
  const { user_id, expo_push_token } = req.body || {};
  if (!user_id || !expo_push_token) {
    return res.status(400).json({
      success: false,
      message: "user_id and expo_push_token are required",
    });
  }

  const removed = store.removeToken(String(user_id), String(expo_push_token));
  return res.json({ success: true, removed });
};

// GET /api/push/tokens/:user_id
exports.listTokensForUser = async (req, res) => {
  const user_id = String(req.params.user_id || "");
  if (!user_id)
    return res
      .status(400)
      .json({ success: false, message: "user_id is required" });

  const tokens = store.getTokensByUser(user_id);
  return res.json({ success: true, user_id, tokens });
};

// POST /api/push/send
// body: { to, title, body, data? }
exports.sendToToken = async (req, res) => {
  const { to, title = "Notification", body = "", data = {} } = req.body || {};

  if (!expo.isExpoToken(to)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid Expo token in 'to'" });
  }

  const result = await expo.sendPushMessages([
    { to, title, body, data, sound: "default" },
  ]);

  return res.json({ success: true, result });
};

// POST /api/push/send-to-user
// body: { user_id, title, body, data? }
exports.sendToUser = async (req, res) => {
  const {
    user_id,
    title = "Notification",
    body = "",
    data = {},
  } = req.body || {};
  if (!user_id)
    return res
      .status(400)
      .json({ success: false, message: "user_id is required" });

  const tokens = store
    .getTokensByUser(String(user_id))
    .map((t) => t.expo_push_token)
    .filter(expo.isExpoToken);

  if (!tokens.length) {
    return res
      .status(404)
      .json({ success: false, message: "No tokens found for this user" });
  }

  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    data,
    sound: "default",
  }));

  const result = await expo.sendPushMessages(messages);

  // Optional cleanup: remove invalid tokens
  // If Expo says "DeviceNotRegistered" in receipts, you can remove them (done in receipts API).
  return res.json({ success: true, sent_to: tokens.length, result });
};

// POST /api/push/receipts
// body: { receipt_ids: ["id1","id2"] }
exports.getReceipts = async (req, res) => {
  const { receipt_ids } = req.body || {};
  if (!Array.isArray(receipt_ids) || receipt_ids.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "receipt_ids array is required" });
  }

  const receipts = await expo.getReceipts(receipt_ids);

  return res.json({ success: true, receipts });
};
