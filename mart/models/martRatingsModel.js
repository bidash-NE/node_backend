const db = require("../config/db");

/* ---------- helpers ---------- */
function toIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}
function toRatingOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5)
    throw new Error("rating must be an integer 1..5");
  return n;
}
const normStr = (s) => (s == null ? null : String(s).trim());

async function assertUserExists(user_id) {
  const [r] = await db.query(
    `SELECT user_id FROM users WHERE user_id = ? LIMIT 1`,
    [user_id]
  );
  if (!r.length) throw new Error("user not found");
}
async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error("business not found");
}

/* ---------- CREATE (always insert new row) ---------- */
async function insertMartRating({ business_id, user_id, rating, comment }) {
  const bid = toIntOrThrow(
    business_id,
    "business_id must be a positive integer"
  );
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");
  const r = toRatingOrThrow(rating);
  const c = normStr(comment);

  await assertUserExists(uid);
  await assertBusinessExists(bid);

  await db.query(
    `INSERT INTO mart_ratings (business_id, user_id, rating, comment)
     VALUES (?, ?, ?, ?)`,
    [bid, uid, r, c]
  );

  return { success: true, message: "Feedback saved." };
}

/* ---------- LIST + AGGREGATES ---------- */
async function fetchMartRatings(business_id, { page = 1, limit = 20 } = {}) {
  const bid = toIntOrThrow(
    business_id,
    "business_id must be a positive integer"
  );
  await assertBusinessExists(bid);

  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (p - 1) * l;

  const [[agg]] = await db.query(
    `SELECT
       COALESCE(ROUND(AVG(rating),2),0) AS avg_rating,
       COUNT(*)                         AS total_ratings,
       SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments
     FROM mart_ratings
     WHERE business_id = ?`,
    [bid]
  );

  const [rows] = await db.query(
    `SELECT
       r.id, r.business_id, r.user_id, r.rating, r.comment, r.created_at,
       u.user_name
     FROM mart_ratings r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.business_id = ?
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [bid, l, offset]
  );

  return {
    success: true,
    data: rows,
    meta: { business_id: bid, page: p, limit: l, ...agg },
  };
}

module.exports = { insertMartRating, fetchMartRatings };
