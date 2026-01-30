// Auto cleanup: poll delivered_orders and delete chats + images
require("dotenv").config();

const path = require("path");
const fs = require("fs/promises");

const db = require("../config/db"); // mysql2 pool (promise)
const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

function ts() {
  return new Date().toISOString();
}
function log(...a) {
  console.log(`[${ts()}] [cleanup]`, ...a);
}

async function safeUnlink(p) {
  try {
    await fs.unlink(p);
    return true;
  } catch {
    return false;
  }
}

function mediaUrlToDiskPath(mediaUrl) {
  if (!mediaUrl) return null;
  let s = String(mediaUrl).trim();
  if (!s) return null;

  // strip host if absolute
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      s = new URL(s).pathname; // "/chat/uploads/chat/xxx.jpg" or "/uploads/chat/xxx.jpg"
    }
  } catch {}

  // normalize "/chat/uploads/.." -> "/uploads/.."
  if (s.startsWith("/chat/uploads/"))
    s = s.replace(/^\/chat\/uploads\//, "/uploads/");

  // we only delete chat folder files
  if (!s.startsWith("/uploads/chat/")) return null;

  const filename = s.split("/").pop();
  if (!filename) return null;

  // disk path: <UPLOAD_ROOT>/chat/<filename>
  return path.join(upload.UPLOAD_ROOT, "chat", filename);
}

// ✅ robust query: tries common columns; falls back if they don't exist
async function fetchDeliveredOrderIds(limit) {
  const sqlVariants = [
    // recommended if you have these columns
    `SELECT order_id FROM delivered_orders WHERE chat_cleaned=0 ORDER BY id ASC LIMIT ?`,
    `SELECT order_id FROM delivered_orders WHERE is_chat_cleaned=0 ORDER BY id ASC LIMIT ?`,
    `SELECT order_id FROM delivered_orders WHERE cleaned=0 ORDER BY id ASC LIMIT ?`,

    // fallback: just newest first
    `SELECT order_id FROM delivered_orders ORDER BY id DESC LIMIT ?`,
    `SELECT order_id FROM delivered_orders ORDER BY created_at DESC LIMIT ?`,

    // last resort: any order_id
    `SELECT order_id FROM delivered_orders LIMIT ?`,
  ];

  for (const sql of sqlVariants) {
    try {
      const [rows] = await db.query(sql, [limit]);
      return { rows, modeSql: sql };
    } catch (e) {
      // try next variant if column doesn't exist
      if (String(e.code) === "ER_BAD_FIELD_ERROR") continue;
      throw e;
    }
  }

  return { rows: [], modeSql: "none" };
}

async function markDbCleaned(orderId) {
  // optional: if you have a cleaned flag, update it; otherwise ignore
  const sqlVariants = [
    `UPDATE delivered_orders SET chat_cleaned=1 WHERE order_id=?`,
    `UPDATE delivered_orders SET is_chat_cleaned=1 WHERE order_id=?`,
    `UPDATE delivered_orders SET cleaned=1 WHERE order_id=?`,
  ];

  for (const sql of sqlVariants) {
    try {
      await db.query(sql, [orderId]);
      return true;
    } catch (e) {
      if (String(e.code) === "ER_BAD_FIELD_ERROR") continue;
      // table might not allow update; ignore
      return false;
    }
  }
  return false;
}

async function cleanupOne(orderId) {
  // idempotency: skip if already cleaned
  if (await store.wasOrderCleaned(orderId)) {
    return { skipped: true, orderId, reason: "already_cleaned(redis)" };
  }

  const del = await store.deleteConversationByOrderId(orderId, {
    deleteFiles: async (mediaUrls) => {
      const paths = [
        ...new Set(mediaUrls.map(mediaUrlToDiskPath).filter(Boolean)),
      ];
      if (paths.length) log("deleting files", { orderId, count: paths.length });

      let ok = 0;
      for (const p of paths) {
        const did = await safeUnlink(p);
        if (did) ok++;
      }
      return ok;
    },
  });

  if (del.deleted) {
    await store.markOrderCleaned(orderId);
    await markDbCleaned(orderId);
  } else {
    // still mark cleaned? no. maybe chat doesn't exist yet.
    // leave it for next runs.
  }

  return del;
}

async function tick() {
  const limit = Math.max(1, Number(process.env.CLEANUP_BATCH_SIZE || 50));
  const graceMin = Number(process.env.CLEANUP_GRACE_MINUTES || 0);

  const { rows, modeSql } = await fetchDeliveredOrderIds(limit);
  log("poll", { found: rows.length, modeSql });

  for (const r of rows) {
    const orderId = String(r.order_id || "").trim();
    if (!orderId) continue;

    // Optional grace period support if your table has created_at
    if (graceMin > 0 && r.created_at) {
      const ageMs = Date.now() - new Date(r.created_at).getTime();
      if (ageMs < graceMin * 60 * 1000) continue;
    }

    const res = await cleanupOne(orderId);
    log("cleanup result", res);
  }
}

async function main() {
  const intervalSec = Math.max(
    5,
    Number(process.env.CLEANUP_POLL_SECONDS || 30),
  );
  log("worker started", {
    intervalSec,
    batch: process.env.CLEANUP_BATCH_SIZE || 50,
    graceMin: process.env.CLEANUP_GRACE_MINUTES || 0,
    uploadRoot: upload.UPLOAD_ROOT,
  });

  // run immediately, then interval
  await tick().catch((e) => log("tick error", e.message));
  setInterval(
    () => tick().catch((e) => log("tick error", e.message)),
    intervalSec * 1000,
  );
}

main().catch((e) => {
  log("fatal", e.message);
  process.exit(1);
});
