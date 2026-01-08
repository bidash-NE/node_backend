// models/merchantRatingsModel.js
const db = require("../config/db");
const moment = require("moment-timezone");
const { getRedis } = require("../config/redis");

const redis = getRedis();

/* ---------- helpers ---------- */
function toIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error("business not found");
}

/** hours since created_at in Asia/Thimphu */
function hoursAgoBT(createdAt) {
  const now = moment.tz("Asia/Thimphu");
  const c = moment.tz(createdAt, "Asia/Thimphu");
  if (!c.isValid()) return null;
  const diff = now.diff(c, "hours");
  return diff >= 0 ? diff : 0;
}

function hoursAgoFromMillis(ms) {
  if (!ms) return null;
  const now = moment.tz("Asia/Thimphu");
  const c = moment.tz(ms, "Asia/Thimphu");
  if (!c.isValid()) return null;
  const diff = now.diff(c, "hours");
  return diff >= 0 ? diff : 0;
}

/* We also reuse the table names in replies logic */
const FOOD_TBL = "food_ratings";
const MART_TBL = "mart_ratings";

/* ---------- Redis keys (replies) ---------- */
const REPLY_SEQ_KEY = "rating:reply:seq";
function replyKey(replyId) {
  return `rating:reply:${replyId}`;
}
function replyIndexKey(rating_type, rating_id) {
  return `rating:replies:idx:${rating_type}:${rating_id}`;
}

/* ---------- ✅ Redis keys (reports) ---------- */
const REPORT_SEQ_KEY = "rating:report:seq";
function reportKey(id) {
  return `rating:report:${id}`;
}
function reportIndexKey(type, target) {
  // target = comment | reply
  return `rating:reports:idx:${type}:${target}`;
}
function reportDedupKey(type, target, targetId, reporterUserId) {
  // ✅ dedupe includes: food/mart + comment/reply + id + reporter
  return `rating:reports:dedup:${type}:${target}:${targetId}:${reporterUserId}`;
}
function reportByTargetKey(type, target, targetId) {
  // to quickly mark/cleanup reports for a specific comment/reply later
  return `rating:reports:by_target:${type}:${target}:${targetId}`;
}

/**
 * Fetch replies for a list of rating rows from Redis + hydrate with user_name/profile_image.
 */
async function fetchRepliesForRatings(ownerType, ratingRows) {
  const result = {};
  const allUserIds = new Set();

  for (const row of ratingRows) {
    const ratingId = row.id;

    const t =
      (row.owner_type && row.owner_type.toLowerCase()) ||
      (ownerType && ownerType.toLowerCase()) ||
      "food";

    const idxKey = replyIndexKey(t, ratingId);
    const replyIds = await redis.zrevrange(idxKey, 0, -1);

    if (!replyIds || replyIds.length === 0) {
      result[ratingId] = [];
      continue;
    }

    const replies = [];
    for (const repId of replyIds) {
      const hKey = replyKey(repId);
      const data = await redis.hgetall(hKey);
      if (!data || Object.keys(data).length === 0) continue;

      const user_id = Number(data.user_id || 0);
      if (user_id > 0) allUserIds.add(user_id);

      const ts = Number(data.created_at || data.ts || 0);

      replies.push({
        id: Number(data.id || repId),
        rating_type: data.rating_type || t,
        rating_id: Number(data.rating_id || ratingId),
        business_id: data.business_id
          ? Number(data.business_id)
          : Number(row.business_id),
        user_id,
        text: data.text || "",
        ts,
        hours_ago: hoursAgoFromMillis(ts),
        user: null,
      });
    }

    replies.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    result[ratingId] = replies;
  }

  if (allUserIds.size > 0) {
    const ids = Array.from(allUserIds);
    const [userRows] = await db.query(
      `
      SELECT user_id, user_name, profile_image
      FROM users
      WHERE user_id IN (?)
    `,
      [ids]
    );

    const userMap = {};
    for (const u of userRows) {
      userMap[u.user_id] = {
        user_id: u.user_id,
        user_name: u.user_name || null,
        profile_image: u.profile_image || null,
      };
    }

    for (const ratingId of Object.keys(result)) {
      const replies = result[ratingId];
      for (const r of replies) {
        r.user = userMap[r.user_id] || null;
      }
    }
  }

  return result;
}

async function getOwnerTypeForBusiness(business_id) {
  const [r] = await db.query(
    `SELECT owner_type
       FROM merchant_business_details
      WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) return "unknown";
  const raw = String(r[0].owner_type || "")
    .trim()
    .toLowerCase();
  if (!raw) return "unknown";
  if (raw === "food" || raw === "mart" || raw === "both") return raw;
  return "unknown";
}

/* ---------- main ratings fetch ---------- */
async function fetchBusinessRatingsAuto(
  business_id,
  { page = 1, limit = 20 } = {}
) {
  const bid = toIntOrThrow(
    business_id,
    "business_id must be a positive integer"
  );
  await assertBusinessExists(bid);

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);
  const offset = (p - 1) * l;

  const ownerType = await getOwnerTypeForBusiness(bid);

  let aggSql, aggParams, listSql, listParams;

  if (ownerType === "mart") {
    aggSql = `
      SELECT
        COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
        COUNT(*) AS total_ratings,
        SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS stars_5,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS stars_4,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS stars_3,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS stars_2,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS stars_1
      FROM ${MART_TBL}
      WHERE business_id = ?
    `;
    aggParams = [bid];

    listSql = `
      SELECT
        r.id, r.business_id, r.user_id, r.rating, r.comment, r.likes_count, r.created_at,
        u.user_name, u.profile_image
      FROM ${MART_TBL} r
      JOIN users u ON u.user_id = r.user_id
      WHERE r.business_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    listParams = [bid, l, offset];
  } else if (ownerType === "food") {
    aggSql = `
      SELECT
        COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
        COUNT(*) AS total_ratings,
        SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS stars_5,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS stars_4,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS stars_3,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS stars_2,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS stars_1
      FROM ${FOOD_TBL}
      WHERE business_id = ?
    `;
    aggParams = [bid];

    listSql = `
      SELECT
        r.id, r.business_id, r.user_id, r.rating, r.comment, r.likes_count, r.created_at,
        u.user_name, u.profile_image
      FROM ${FOOD_TBL} r
      JOIN users u ON u.user_id = r.user_id
      WHERE r.business_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    listParams = [bid, l, offset];
  } else {
    aggSql = `
      SELECT
        COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
        COUNT(*) AS total_ratings,
        SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS stars_5,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS stars_4,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS stars_3,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS stars_2,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS stars_1
      FROM (
        SELECT rating, comment FROM ${FOOD_TBL} WHERE business_id = ?
        UNION ALL
        SELECT rating, comment FROM ${MART_TBL} WHERE business_id = ?
      ) t
    `;
    aggParams = [bid, bid];

    listSql = `
      SELECT *
      FROM (
        SELECT
          'food' AS owner_type,
          r.id, r.business_id, r.user_id, r.rating, r.comment, r.likes_count, r.created_at,
          u.user_name, u.profile_image
        FROM ${FOOD_TBL} r
        JOIN users u ON u.user_id = r.user_id
        WHERE r.business_id = ?
        UNION ALL
        SELECT
          'mart' AS owner_type,
          r.id, r.business_id, r.user_id, r.rating, r.comment, r.likes_count, r.created_at,
          u.user_name, u.profile_image
        FROM ${MART_TBL} r
        JOIN users u ON u.user_id = r.user_id
        WHERE r.business_id = ?
      ) x
      ORDER BY x.created_at DESC
      LIMIT ? OFFSET ?
    `;
    listParams = [bid, bid, l, offset];
  }

  const [[agg]] = await db.query(aggSql, aggParams);
  const [rows] = await db.query(listSql, listParams);

  const repliesByRating = await fetchRepliesForRatings(ownerType, rows);

  const items = rows.map((r) => {
    const replies = repliesByRating[r.id] || [];

    return {
      id: r.id,
      business_id: r.business_id,
      owner_type: r.owner_type || ownerType,
      user: {
        user_id: r.user_id,
        user_name: r.user_name || null,
        profile_image: r.profile_image || null,
      },
      rating: r.rating,
      comment: r.comment,
      likes_count: Number(r.likes_count ?? 0),
      created_at: r.created_at,
      hours_ago: hoursAgoBT(r.created_at),

      reply_count: replies.length,
      replies,
    };
  });

  return {
    success: true,
    data: items,
    meta: {
      business_id: bid,
      owner_type: ownerType,
      page: p,
      limit: l,
      totals: {
        avg_rating: Number(agg?.avg_rating ?? 0),
        total_ratings: Number(agg?.total_ratings ?? 0),
        total_comments: Number(agg?.total_comments ?? 0),
        by_stars: {
          5: Number(agg?.stars_5 ?? 0),
          4: Number(agg?.stars_4 ?? 0),
          3: Number(agg?.stars_3 ?? 0),
          2: Number(agg?.stars_2 ?? 0),
          1: Number(agg?.stars_1 ?? 0),
        },
      },
    },
  };
}

/* ---------- like / unlike ---------- */

async function likeFoodRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const [res] = await db.query(
    `UPDATE ${FOOD_TBL}
       SET likes_count = likes_count + 1
     WHERE id = ?`,
    [rid]
  );

  if (res.affectedRows === 0) throw new Error("food rating not found");

  const [[row]] = await db.query(
    `SELECT id, business_id, likes_count
       FROM ${FOOD_TBL}
      WHERE id = ?
      LIMIT 1`,
    [rid]
  );

  return {
    success: true,
    data: {
      id: row.id,
      business_id: row.business_id,
      likes_count: Number(row.likes_count ?? 0),
    },
  };
}

async function unlikeFoodRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const [res] = await db.query(
    `UPDATE ${FOOD_TBL}
       SET likes_count = GREATEST(likes_count - 1, 0)
     WHERE id = ?`,
    [rid]
  );

  if (res.affectedRows === 0) throw new Error("food rating not found");

  const [[row]] = await db.query(
    `SELECT id, business_id, likes_count
       FROM ${FOOD_TBL}
      WHERE id = ?
      LIMIT 1`,
    [rid]
  );

  return {
    success: true,
    data: {
      id: row.id,
      business_id: row.business_id,
      likes_count: Number(row.likes_count ?? 0),
    },
  };
}

async function likeMartRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const [res] = await db.query(
    `UPDATE ${MART_TBL}
       SET likes_count = likes_count + 1
     WHERE id = ?`,
    [rid]
  );

  if (res.affectedRows === 0) throw new Error("mart rating not found");

  const [[row]] = await db.query(
    `SELECT id, business_id, likes_count
       FROM ${MART_TBL}
      WHERE id = ?
      LIMIT 1`,
    [rid]
  );

  return {
    success: true,
    data: {
      id: row.id,
      business_id: row.business_id,
      likes_count: Number(row.likes_count ?? 0),
    },
  };
}

async function unlikeMartRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const [res] = await db.query(
    `UPDATE ${MART_TBL}
       SET likes_count = GREATEST(likes_count - 1, 0)
     WHERE id = ?`,
    [rid]
  );

  if (res.affectedRows === 0) throw new Error("mart rating not found");

  const [[row]] = await db.query(
    `SELECT id, business_id, likes_count
       FROM ${MART_TBL}
      WHERE id = ?
      LIMIT 1`,
    [rid]
  );

  return {
    success: true,
    data: {
      id: row.id,
      business_id: row.business_id,
      likes_count: Number(row.likes_count ?? 0),
    },
  };
}

/* ---------- replies ---------- */

async function assertRatingExistsAndGetBusiness(rating_type, rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  const tbl = rating_type === "mart" ? MART_TBL : FOOD_TBL;

  const [rows] = await db.query(
    `SELECT id, business_id FROM ${tbl} WHERE id = ? LIMIT 1`,
    [rid]
  );
  if (!rows.length) {
    const err = new Error(`${rating_type} rating not found`);
    err.code = "RATING_NOT_FOUND";
    throw err;
  }
  return { rating_id: rid, business_id: rows[0].business_id };
}

async function createRatingReply({ rating_type, rating_id, user_id, text }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");
  const { rating_id: rid, business_id } =
    await assertRatingExistsAndGetBusiness(type, rating_id);

  const now = Date.now();
  const newId = await redis.incr(REPLY_SEQ_KEY);
  const key = replyKey(newId);
  const idxKey = replyIndexKey(type, rid);

  await redis
    .multi()
    .hmset(key, {
      id: String(newId),
      rating_type: type,
      rating_id: String(rid),
      business_id: String(business_id),
      user_id: String(uid),
      text: String(text),
      created_at: String(now),
      updated_at: String(now),
    })
    .zadd(idxKey, now, String(newId))
    .exec();

  return {
    success: true,
    data: {
      id: newId,
      rating_type: type,
      rating_id: rid,
      business_id,
      user_id: uid,
      text,
      created_at: now,
      updated_at: now,
    },
  };
}

async function listRatingReplies({
  rating_type,
  rating_id,
  page = 1,
  limit = 20,
}) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  await assertRatingExistsAndGetBusiness(type, rid);

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);
  const start = (p - 1) * l;
  const stop = start + l - 1;

  const idxKey = replyIndexKey(type, rid);

  const [ids, totalStr] = await Promise.all([
    redis.zrevrange(idxKey, start, stop),
    redis.zcard(idxKey),
  ]);

  const total = Number(totalStr || 0);

  if (!ids.length) {
    return {
      success: true,
      data: [],
      meta: { rating_type: type, rating_id: rid, page: p, limit: l, total },
    };
  }

  const pipe = redis.multi();
  ids.forEach((id) => pipe.hgetall(replyKey(id)));
  const rowsArr = await pipe.exec();

  const data = [];
  const userIds = new Set();

  for (let i = 0; i < ids.length; i++) {
    const [err, row] = rowsArr[i];
    if (err) continue;
    if (!row || !row.id) continue;

    const createdAt = Number(row.created_at || Date.now());
    const item = {
      id: Number(row.id),
      rating_type: row.rating_type,
      rating_id: Number(row.rating_id),
      business_id: row.business_id ? Number(row.business_id) : null,
      user_id: Number(row.user_id),
      text: row.text,
      created_at: createdAt,
      updated_at: Number(row.updated_at || createdAt),
      hours_ago: hoursAgoFromMillis(createdAt),
      user: null,
    };

    if (item.user_id > 0) userIds.add(item.user_id);
    data.push(item);
  }

  if (userIds.size > 0) {
    const idsArr = Array.from(userIds);
    const [userRows] = await db.query(
      `
      SELECT user_id, user_name, profile_image
      FROM users
      WHERE user_id IN (?)
    `,
      [idsArr]
    );

    const userMap = {};
    for (const u of userRows) {
      userMap[u.user_id] = {
        user_id: u.user_id,
        user_name: u.user_name || null,
        profile_image: u.profile_image || null,
      };
    }

    for (const reply of data) {
      reply.user = userMap[reply.user_id] || null;
    }
  }

  return {
    success: true,
    data,
    meta: { rating_type: type, rating_id: rid, page: p, limit: l, total },
  };
}

async function deleteRatingReply({ reply_id, user_id }) {
  const rid = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");

  const key = replyKey(rid);
  const row = await redis.hgetall(key);

  if (!row || !row.id) {
    const err = new Error("Reply not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const ownerId = Number(row.user_id || 0);
  if (ownerId !== uid) {
    const err = new Error("You are not allowed to delete this reply");
    err.code = "FORBIDDEN";
    throw err;
  }

  const type = row.rating_type;
  const ratingId = row.rating_id;
  const idxKey = replyIndexKey(type, ratingId);

  await redis.multi().del(key).zrem(idxKey, String(rid)).exec();

  return {
    success: true,
    message: "Reply deleted",
    data: { id: rid, rating_type: type, rating_id: Number(ratingId) },
  };
}

async function deleteRatingWithReplies({ rating_type, rating_id, user_id }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");
  const tbl = type === "mart" ? MART_TBL : FOOD_TBL;

  const [rows] = await db.query(
    `SELECT id, business_id, user_id FROM ${tbl} WHERE id = ? LIMIT 1`,
    [rid]
  );
  if (!rows.length) {
    const err = new Error(`${type} rating not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const ownerId = Number(rows[0].user_id || 0);
  if (ownerId !== uid) {
    const err = new Error("You are not allowed to delete this rating");
    err.code = "FORBIDDEN";
    throw err;
  }

  const [delRes] = await db.query(`DELETE FROM ${tbl} WHERE id = ? LIMIT 1`, [
    rid,
  ]);
  if (delRes.affectedRows === 0) {
    const err = new Error(`${type} rating not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const idxKey = replyIndexKey(type, rid);
  const replyIds = await redis.zrange(idxKey, 0, -1);

  const multi = redis.multi();
  if (replyIds && replyIds.length > 0) {
    for (const replId of replyIds) multi.del(replyKey(replId));
  }
  multi.del(idxKey);

  await multi.exec();

  return {
    success: true,
    message: "Rating and its replies deleted successfully.",
    data: {
      rating_type: type,
      rating_id: rid,
      deleted_replies: replyIds ? replyIds.length : 0,
    },
  };
}

/* ---------- ✅ NEW: REPORTS (comment + reply) ---------- */

async function loadRatingRow(type, rating_id) {
  const tbl = type === "mart" ? MART_TBL : FOOD_TBL;
  const [rows] = await db.query(
    `SELECT id, business_id, user_id, comment, created_at FROM ${tbl} WHERE id = ? LIMIT 1`,
    [rating_id]
  );
  if (!rows.length) {
    const err = new Error(`${type} rating not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return rows[0];
}

async function loadReplyRow(reply_id) {
  const rid = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const row = await redis.hgetall(replyKey(rid));
  if (!row || !row.id) {
    const err = new Error("Reply not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  return {
    id: Number(row.id),
    rating_type: String(row.rating_type || "").toLowerCase(),
    rating_id: Number(row.rating_id || 0),
    business_id: Number(row.business_id || 0),
    user_id: Number(row.user_id || 0),
    text: row.text || "",
    created_at: Number(row.created_at || 0),
  };
}

async function reportRating({
  rating_type,
  rating_id,
  reporter_user_id,
  reason,
}) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  const uid = toIntOrThrow(
    reporter_user_id,
    "reporter_user_id must be a positive integer"
  );

  const dedup = reportDedupKey(type, "comment", rid, uid);
  const already = await redis.get(dedup);
  if (already) {
    const err = new Error("You already reported this rating");
    err.code = "DUPLICATE";
    throw err;
  }

  const row = await loadRatingRow(type, rid);

  const now = Date.now();
  const newId = await redis.incr(REPORT_SEQ_KEY);

  const key = reportKey(newId);
  const idxKey = reportIndexKey(type, "comment");
  const byTarget = reportByTargetKey(type, "comment", rid);

  await redis
    .multi()
    .set(dedup, "1", "EX", 60 * 60 * 24 * 30) // 30d
    .hmset(key, {
      id: String(newId),
      type, // food/mart
      target: "comment",
      rating_id: String(rid),
      reply_id: "",
      business_id: String(row.business_id || ""),
      reported_user_id: String(row.user_id || ""),
      reporter_user_id: String(uid),
      reason: String(reason),
      reported_text: String(row.comment || ""), // ✅ store actual comment
      created_at: String(now),
      status: "open", // open | ignored | deleted
    })
    .zadd(idxKey, now, String(newId))
    .sadd(byTarget, String(newId))
    .exec();

  return {
    success: true,
    message: "Reported successfully",
    data: {
      report_id: newId,
      type,
      target: "comment",
      rating_id: rid,
      reason,
      reported_text: row.comment || "",
    },
  };
}

async function reportReply({
  rating_type,
  reply_id,
  reporter_user_id,
  reason,
}) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const repId = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const uid = toIntOrThrow(
    reporter_user_id,
    "reporter_user_id must be a positive integer"
  );

  const dedup = reportDedupKey(type, "reply", repId, uid);
  const already = await redis.get(dedup);
  if (already) {
    const err = new Error("You already reported this reply");
    err.code = "DUPLICATE";
    throw err;
  }

  const replyRow = await loadReplyRow(repId);

  const now = Date.now();
  const newId = await redis.incr(REPORT_SEQ_KEY);

  const key = reportKey(newId);
  const idxKey = reportIndexKey(type, "reply");
  const byTarget = reportByTargetKey(type, "reply", repId);

  await redis
    .multi()
    .set(dedup, "1", "EX", 60 * 60 * 24 * 30) // 30d
    .hmset(key, {
      id: String(newId),
      type, // food/mart
      target: "reply",
      rating_id: String(replyRow.rating_id || ""),
      reply_id: String(repId),
      business_id: String(replyRow.business_id || ""),
      reported_user_id: String(replyRow.user_id || ""),
      reporter_user_id: String(uid),
      reason: String(reason),
      reported_text: String(replyRow.text || ""), // ✅ store actual reply
      created_at: String(now),
      status: "open", // open | ignored | deleted
    })
    .zadd(idxKey, now, String(newId))
    .sadd(byTarget, String(newId))
    .exec();

  return {
    success: true,
    message: "Reported successfully",
    data: {
      report_id: newId,
      type,
      target: "reply",
      reply_id: repId,
      reason,
      reported_text: replyRow.text || "",
    },
  };
}

module.exports = {
  fetchBusinessRatingsAuto,
  likeFoodRating,
  unlikeFoodRating,
  likeMartRating,
  unlikeMartRating,

  createRatingReply,
  listRatingReplies,
  deleteRatingReply,
  deleteRatingWithReplies,

  // ✅ NEW reports
  reportRating,
  reportReply,
};
