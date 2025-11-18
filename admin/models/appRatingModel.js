// models/appRatingModel.js
const db = require("../config/db");

/**
 * Create a new app rating row.
 */
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

/**
 * Get a single app rating by ID.
 */
async function getAppRatingById(id) {
  const [rows] = await db.query(`SELECT * FROM app_ratings WHERE id = ?`, [id]);
  return rows[0] || null;
}

/**
 * List app ratings with basic filters + pagination.
 * filters = { minRating, maxRating, platform, appVersion, limit, offset }
 */
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

/**
 * Update an app rating (mainly rating & comment).
 * fields = { rating?, comment? }
 */
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

  if (!setParts.length) {
    return { affectedRows: 0 };
  }

  const sql = `
    UPDATE app_ratings
    SET ${setParts.join(", ")}
    WHERE id = ?
  `;
  params.push(id);

  const [result] = await db.query(sql, params);
  return result;
}

/**
 * Delete an app rating by ID.
 */
async function deleteAppRating(id) {
  const [result] = await db.query(`DELETE FROM app_ratings WHERE id = ?`, [id]);
  return result;
}

/**
 * Summary stats for admin dashboard:
 * - total_ratings
 * - avg_rating
 * - breakdown by rating
 */
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

module.exports = {
  createAppRating,
  getAppRatingById,
  listAppRatings,
  updateAppRating,
  deleteAppRating,
  getAppRatingSummary,
};
