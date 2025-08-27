const db = require("../config/db");

function toPosIntOrThrow(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer`);
  return n;
}

async function createMartMenuRating({ menu_id, user_id, rating, comment }) {
  const mid = toPosIntOrThrow(menu_id, "menu_id");
  const uid = toPosIntOrThrow(user_id, "user_id");
  const r = Number(rating);
  if (!(r >= 1 && r <= 5)) throw new Error("rating must be 1..5");
  const c = comment == null ? null : String(comment).trim();

  // upsert per (menu_id, user_id)
  await db.query(
    `
    INSERT INTO mart_menu_ratings (menu_id, user_id, rating, comment)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), updated_at = CURRENT_TIMESTAMP
    `,
    [mid, uid, r, c]
  );

  return { success: true, message: "Rating saved." };
}

async function getMartMenuRatingSummary(menu_id) {
  const mid = toPosIntOrThrow(menu_id, "menu_id");
  const [rows] = await db.query(
    `
    SELECT
      COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
      COUNT(*) AS total_ratings,
      SUM(CASE WHEN comment IS NOT NULL AND comment <> '' THEN 1 ELSE 0 END) AS total_comments
    FROM mart_menu_ratings
    WHERE menu_id = ?
    `,
    [mid]
  );
  const [list] = await db.query(
    `SELECT user_id, rating, comment, created_at FROM mart_menu_ratings WHERE menu_id = ? ORDER BY created_at DESC LIMIT 50`,
    [mid]
  );
  return { success: true, data: { summary: rows[0], latest: list } };
}

module.exports = { createMartMenuRating, getMartMenuRatingSummary };
