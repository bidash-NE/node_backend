const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TOKENS_FILE))
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ tokens: [] }, null, 2));
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(TOKENS_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { tokens: [] };
  }
}

function writeAll(data) {
  ensureFile();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

// Upsert by (user_id + expo_push_token)
function upsertToken({ user_id, expo_push_token, device_id, platform }) {
  const db = readAll();
  const now = Date.now();

  const idx = db.tokens.findIndex(
    (t) => t.user_id === user_id && t.expo_push_token === expo_push_token,
  );

  const record = {
    user_id,
    expo_push_token,
    device_id,
    platform,
    updated_at: now,
  };

  if (idx >= 0) {
    db.tokens[idx] = { ...db.tokens[idx], ...record };
  } else {
    db.tokens.push({ ...record, created_at: now });
  }

  writeAll(db);
  return record;
}

function removeToken(user_id, expo_push_token) {
  const db = readAll();
  const before = db.tokens.length;
  db.tokens = db.tokens.filter(
    (t) => !(t.user_id === user_id && t.expo_push_token === expo_push_token),
  );
  writeAll(db);
  return { before, after: db.tokens.length };
}

function getTokensByUser(user_id) {
  const db = readAll();
  return db.tokens.filter((t) => t.user_id === user_id);
}

module.exports = {
  upsertToken,
  removeToken,
  getTokensByUser,
};
