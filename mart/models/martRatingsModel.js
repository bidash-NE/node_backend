// models/foodRatingsModel.js
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
async function assertFoodMenuExists(menu_id) {
  const [r] = await db.query(`SELECT id FROM food_menu WHERE id = ? LIMIT 1`, [
    menu_id,
  ]);
  if (!r.length) throw new Error("menu item not found");
}

/* ---------- upsert rating ---------- */
async function upsertFoodMenuRating({ menu_id, user_id, rating, comment }) {
  const mid = toIntOrThrow(menu_id, "menu_id must be a positive integer");
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");
  const r = toRatingOrThrow(rating);
  const c = normStr(comment);

  await assertUserExists(uid);
  await assertFoodMenuExists(mid);

  // unique (menu_id,user_id)
  const [exists] = await db.query(
    `SELECT id FROM food_menu_ratings WHERE menu_id = ? AND user_id = ? LIMIT 1`,
    [mid, uid]
  );

  if (exists.length) {
    await db.query(
      `UPDATE food_menu_ratings
          SET rating = ?, comment = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [r, c, exists[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO food_menu_ratings (menu_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)`,
      [mid, uid, r, c]
    );
  }

  return { success: true, message: "Rating saved." };
}

/* ---------- fetch ratings list + aggregates ---------- */
async function fetchFoodMenuRatings(menu_id, { page = 1, limit = 20 } = {}) {
  const mid = toIntOrThrow(menu_id, "menu_id must be a positive integer");
  await assertFoodMenuExists(mid);

  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (p - 1) * l;

  const [[agg]] = await db.query(
    `SELECT
       COALESCE(ROUND(AVG(rating),2),0) AS avg_rating,
       COUNT(*)                         AS total_ratings,
       SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments
     FROM food_menu_ratings
     WHERE menu_id = ?`,
    [mid]
  );

  const [rows] = await db.query(
    `SELECT
       r.id, r.menu_id, r.user_id, r.rating, r.comment, r.created_at,
       u.user_name
     FROM food_menu_ratings r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.menu_id = ?
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [mid, l, offset]
  );

  return {
    success: true,
    data: rows,
    meta: { menu_id: mid, page: p, limit: l, ...agg },
  };
}

module.exports = { upsertFoodMenuRating, fetchFoodMenuRatings };
