const db = require("../config/db");
const moment = require("moment-timezone");

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

/**
 * Reads the owner type from merchant_business_details.
 * Expecting values like 'food' | 'mart' | 'both' (case-insensitive).
 * If the column name differs in your schema, change it below.
 */
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

/** hours since created_at in Asia/Thimphu */
function hoursAgoBT(createdAt) {
  const now = moment.tz("Asia/Thimphu");
  const c = moment.tz(createdAt, "Asia/Thimphu");
  if (!c.isValid()) return null;
  const diff = now.diff(c, "hours");
  return diff >= 0 ? diff : 0;
}

/* ---------- main: chooses table by owner_type ---------- */
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

  // detect owner_type
  const ownerType = await getOwnerTypeForBusiness(bid);

  // table names
  const FOOD_TBL = "food_ratings";
  const MART_TBL = "mart_ratings";

  let aggSql, aggParams, listSql, listParams;

  if (ownerType === "mart") {
    // MART ONLY
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
        r.id, r.business_id, r.user_id, r.rating, r.comment, r.created_at,
        u.user_name, u.profile_image
      FROM ${MART_TBL} r
      JOIN users u ON u.user_id = r.user_id
      WHERE r.business_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    listParams = [bid, l, offset];
  } else if (ownerType === "food") {
    // FOOD ONLY
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
        r.id, r.business_id, r.user_id, r.rating, r.comment, r.created_at,
        u.user_name, u.profile_image
      FROM ${FOOD_TBL} r
      JOIN users u ON u.user_id = r.user_id
      WHERE r.business_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    listParams = [bid, l, offset];
  } else {
    // BOTH or UNKNOWN → merge both (handy if you later enable BOTH businesses)
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
          r.id, r.business_id, r.user_id, r.rating, r.comment, r.created_at,
          u.user_name, u.profile_image
        FROM ${FOOD_TBL} r
        JOIN users u ON u.user_id = r.user_id
        WHERE r.business_id = ?
        UNION ALL
        SELECT
          'mart' AS owner_type,
          r.id, r.business_id, r.user_id, r.rating, r.comment, r.created_at,
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

  const items = rows.map((r) => ({
    id: r.id,
    business_id: r.business_id,
    owner_type: r.owner_type || ownerType, // 'food'/'mart' if union path; else single-source
    user: {
      user_id: r.user_id,
      user_name: r.user_name || null,
      profile_image: r.profile_image || null,
    },
    rating: r.rating,
    comment: r.comment,
    created_at: r.created_at,
    hours_ago: hoursAgoBT(r.created_at),
  }));

  return {
    success: true,
    data: items,
    meta: {
      business_id: bid,
      owner_type: ownerType, // 'food' | 'mart' | 'both' | 'unknown'
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

module.exports = { fetchBusinessRatingsAuto };
