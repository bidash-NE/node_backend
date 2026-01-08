// models/appRatingModel.js  ✅ FULL (ADMIN SIDE)
const db = require("../config/db");
const { getRedis } = require("../config/redis"); // must return ioredis client

const redis = getRedis();

/* ---------------- existing app rating model ---------------- */

async function createAppRating({
  user_id = null,
  role = null,
  rating,
  comment = null,
  platform = null,
  os_version = null,
  app_version = null,
  device_model = null,
  network_type = null,
}) {
  const sql = `
    INSERT INTO app_ratings (
      user_id,
      role,
      rating,
      comment,
      platform,
      os_version,
      app_version,
      device_model,
      network_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    user_id,
    role,
    rating,
    comment,
    platform,
    os_version,
    app_version,
    device_model,
    network_type,
  ];

  const [result] = await db.query(sql, params);
  const insertId = result.insertId;

  const [rows] = await db.query(`SELECT * FROM app_ratings WHERE id = ?`, [
    insertId,
  ]);

  return rows[0] || null;
}

async function getAppRatingById(id) {
  const [rows] = await db.query(`SELECT * FROM app_ratings WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function listAppRatings(filters = {}) {
  const {
    minRating,
    maxRating,
    platform,
    appVersion,
    limit = 50,
    offset = 0,
  } = filters;

  let sql = `
    SELECT *
    FROM app_ratings
    WHERE 1=1
  `;
  const params = [];

  if (minRating != null) {
    sql += ` AND rating >= ?`;
    params.push(minRating);
  }
  if (maxRating != null) {
    sql += ` AND rating <= ?`;
    params.push(maxRating);
  }
  if (platform) {
    sql += ` AND platform = ?`;
    params.push(platform);
  }
  if (appVersion) {
    sql += ` AND app_version = ?`;
    params.push(appVersion);
  }

  sql += `
    ORDER BY created_at DESC
    LIMIT ?
    OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const [rows] = await db.query(sql, params);
  return rows;
}

async function updateAppRating(id, fields = {}) {
  const allowed = ["rating", "comment"];
  const setParts = [];
  const params = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      setParts.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  if (!setParts.length) return { affectedRows: 0 };

  const sql = `
    UPDATE app_ratings
    SET ${setParts.join(", ")}
    WHERE id = ?
  `;
  params.push(id);

  const [result] = await db.query(sql, params);
  return result;
}

async function deleteAppRating(id) {
  const [result] = await db.query(`DELETE FROM app_ratings WHERE id = ?`, [id]);
  return result;
}

async function getAppRatingSummary() {
  const [[totals]] = await db.query(`
    SELECT
      COUNT(*) AS total_ratings,
      AVG(rating) AS avg_rating
    FROM app_ratings
  `);

  const [breakdownRows] = await db.query(`
    SELECT rating, COUNT(*) AS count
    FROM app_ratings
    GROUP BY rating
    ORDER BY rating DESC
  `);

  return {
    total_ratings: totals.total_ratings || 0,
    avg_rating: totals.avg_rating ? Number(totals.avg_rating) : 0,
    breakdown: breakdownRows.map((row) => ({
      rating: row.rating,
      count: row.count,
    })),
  };
}

/* ---------------- ✅ REPORTS (ADMIN) ---------------- */

const FOOD_TBL = "food_ratings";
const MART_TBL = "mart_ratings";

/* reply keys (same as merchant service) */
function replyKey(replyId) {
  return `rating:reply:${replyId}`;
}
function replyIndexKey(rating_type, rating_id) {
  return `rating:replies:idx:${rating_type}:${rating_id}`;
}

/* report keys (same as merchant service) */
function reportKey(id) {
  return `rating:report:${id}`;
}
function reportIndexKey(type, target) {
  return `rating:reports:idx:${type}:${target}`;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

async function hydrateUsers(ids) {
  const clean = (ids || []).map((x) => Number(x)).filter((x) => x > 0);
  if (!clean.length) return {};
  const [rows] = await db.query(
    `SELECT user_id, user_name, phone, email, profile_image, role
       FROM users
      WHERE user_id IN (?)`,
    [clean]
  );
  const map = {};
  for (const r of rows) {
    map[r.user_id] = {
      user_id: r.user_id,
      user_name: r.user_name || null,
      phone: r.phone || null,
      email: r.email || null,
      profile_image: r.profile_image || null,
      role: r.role || null,
    };
  }
  return map;
}

/**
 * List reports for type+target.
 * ✅ Returns only OPEN reports (ignored/deleted are hidden).
 * ✅ Includes reason + reported_text + reporter + reported_user.
 */
async function listMerchantReports({ type, target, page = 1, limit = 20 }) {
  const t = String(type || "").toLowerCase();
  const trg = String(target || "").toLowerCase();

  if (t !== "food" && t !== "mart")
    throw new Error("type must be food or mart");
  if (trg !== "comment" && trg !== "reply")
    throw new Error("target must be comment or reply");

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);
  const start = (p - 1) * l;
  const stop = start + l - 1;

  const idxKey = reportIndexKey(t, trg);

  // ioredis: zrevrange exists
  const [ids, total] = await Promise.all([
    redis.zrevrange(idxKey, start, stop),
    redis.zcard(idxKey),
  ]);

  if (!ids || !ids.length) {
    return {
      success: true,
      data: [],
      meta: {
        type: t,
        target: trg,
        page: p,
        limit: l,
        total: Number(total || 0),
      },
    };
  }

  const pipe = redis.multi();
  ids.forEach((id) => pipe.hgetall(reportKey(id)));
  const results = await pipe.exec();

  const rows = [];
  const userIds = new Set();

  for (let i = 0; i < ids.length; i++) {
    const [err, h] = results[i] || [];
    if (err) continue;
    if (!h || !h.id) continue;

    const status = String(h.status || "open").toLowerCase();
    if (status !== "open") continue;

    const reporter = toInt(h.reporter_user_id);
    const reported = toInt(h.reported_user_id);
    if (reporter) userIds.add(reporter);
    if (reported) userIds.add(reported);

    rows.push({
      report_id: toInt(h.id),
      type: String(h.type || t),
      target: String(h.target || trg),
      rating_id: toInt(h.rating_id),
      reply_id: toInt(h.reply_id),
      business_id: toInt(h.business_id),
      reporter_user_id: reporter,
      reported_user_id: reported,
      reason: h.reason || "",
      reported_text: h.reported_text || "",
      created_at: toInt(h.created_at),
      status,
    });
  }

  const userMap = await hydrateUsers(Array.from(userIds));

  return {
    success: true,
    data: rows.map((r) => ({
      ...r,
      reporter: userMap[r.reporter_user_id] || null,
      reported_user: userMap[r.reported_user_id] || null,
    })),
    meta: {
      type: t,
      target: trg,
      page: p,
      limit: l,
      total: Number(total || 0),
    },
  };
}

/**
 * Ignore: mark status=ignored and remove from open index so it won't show.
 */
async function ignoreMerchantReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }
  if (!admin?.admin_user_id) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const key = reportKey(rid);
  const h = await redis.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();
  if (
    (type !== "food" && type !== "mart") ||
    (target !== "comment" && target !== "reply")
  ) {
    const err = new Error("Report data is invalid");
    err.statusCode = 400;
    throw err;
  }

  await redis
    .multi()
    .hset(
      key,
      "status",
      "ignored",
      "reviewed_by",
      String(admin.admin_user_id),
      "reviewed_at",
      String(Date.now())
    )
    .zrem(reportIndexKey(type, target), String(rid))
    .exec();

  return {
    success: true,
    message: "Report ignored",
    data: { report_id: rid, status: "ignored" },
  };
}

/**
 * Delete reported COMMENT (rating row) using report_id:
 * - delete row from DB (food_ratings/mart_ratings)
 * - delete all replies for that rating (Redis)
 * - mark report deleted + remove from open index
 */
async function deleteReportedMerchantCommentByReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }
  if (!admin?.admin_user_id) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const key = reportKey(rid);
  const h = await redis.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();
  const rating_id = Number(h.rating_id || 0);

  if (target !== "comment") {
    const err = new Error("This report is not for a comment");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(rating_id) || rating_id <= 0) {
    const err = new Error("Invalid rating_id in report");
    err.statusCode = 400;
    throw err;
  }

  const tbl = type === "mart" ? MART_TBL : FOOD_TBL;

  // delete comment row if exists
  await db.query(`DELETE FROM ${tbl} WHERE id = ?`, [rating_id]);

  // delete replies for rating
  const idxReplies = replyIndexKey(type, rating_id);
  const replyIds = await redis.zrange(idxReplies, 0, -1);

  const multi = redis.multi();
  if (replyIds && replyIds.length) {
    replyIds.forEach((repId) => multi.del(replyKey(repId)));
  }
  multi.del(idxReplies);

  // close report
  multi
    .hset(
      key,
      "status",
      "deleted",
      "reviewed_by",
      String(admin.admin_user_id),
      "reviewed_at",
      String(Date.now())
    )
    .zrem(reportIndexKey(type, "comment"), String(rid));

  await multi.exec();

  return {
    success: true,
    message: "Reported comment deleted",
    data: {
      report_id: rid,
      type,
      target: "comment",
      rating_id,
      deleted_replies: replyIds ? replyIds.length : 0,
      status: "deleted",
    },
  };
}

/**
 * Delete reported REPLY (Redis) using report_id:
 * - delete reply hash
 * - remove reply id from rating replies index
 * - mark report deleted + remove from open index
 */
async function deleteReportedMerchantReplyByReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }
  if (!admin?.admin_user_id) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const key = reportKey(rid);
  const h = await redis.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();
  const reply_id = Number(h.reply_id || 0);

  if (target !== "reply") {
    const err = new Error("This report is not for a reply");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(reply_id) || reply_id <= 0) {
    const err = new Error("Invalid reply_id in report");
    err.statusCode = 400;
    throw err;
  }

  const repKey = replyKey(reply_id);
  const rep = await redis.hgetall(repKey);

  const multi = redis.multi();

  if (rep && rep.id) {
    const rating_id = Number(rep.rating_id || 0);
    const rating_type = String(rep.rating_type || type).toLowerCase();
    if (rating_id > 0 && (rating_type === "food" || rating_type === "mart")) {
      multi.zrem(replyIndexKey(rating_type, rating_id), String(reply_id));
    }
    multi.del(repKey);
  }

  // close report
  multi
    .hset(
      key,
      "status",
      "deleted",
      "reviewed_by",
      String(admin.admin_user_id),
      "reviewed_at",
      String(Date.now())
    )
    .zrem(reportIndexKey(type, "reply"), String(rid));

  await multi.exec();

  return {
    success: true,
    message: "Reported reply deleted",
    data: {
      report_id: rid,
      type,
      target: "reply",
      reply_id,
      status: "deleted",
    },
  };
}

module.exports = {
  createAppRating,
  getAppRatingById,
  listAppRatings,
  updateAppRating,
  deleteAppRating,
  getAppRatingSummary,

  // ✅ REPORTS
  listMerchantReports,
  ignoreMerchantReport,
  deleteReportedMerchantCommentByReport,
  deleteReportedMerchantReplyByReport,
};
