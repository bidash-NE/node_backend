// models/pointSystemModel.js
const pool = require("../config/db");

/**
 * Get all point rules
 * @param {boolean} onlyActive - if true, filter by is_active = 1
 */
async function getAllPointRules(onlyActive = false) {
  let sql = `
    SELECT 
      point_id,
      min_amount_per_point,
      point_to_award,
      is_active,
      created_at,
      updated_at
    FROM point_system
  `;
  const params = [];

  if (onlyActive) {
    sql += " WHERE is_active = 1";
  }

  sql += " ORDER BY created_at DESC";

  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Get single point rule by id
 */
async function getPointRuleById(point_id) {
  const [rows] = await pool.query(
    `
    SELECT 
      point_id,
      min_amount_per_point,
      point_to_award,
      is_active,
      created_at,
      updated_at
    FROM point_system
    WHERE point_id = ?
    LIMIT 1
    `,
    [point_id]
  );
  return rows[0] || null;
}

/**
 * Create new point rule
 */
async function createPointRule({
  min_amount_per_point,
  point_to_award,
  is_active = 1,
}) {
  const [result] = await pool.query(
    `
    INSERT INTO point_system (
      min_amount_per_point,
      point_to_award,
      is_active,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    [min_amount_per_point, point_to_award, is_active ? 1 : 0]
  );

  const insertedId = result.insertId;
  return await getPointRuleById(insertedId);
}

/**
 * Update existing point rule
 * Supports partial update (any of the fields can be undefined)
 */
async function updatePointRule(
  point_id,
  { min_amount_per_point, point_to_award, is_active }
) {
  const fields = [];
  const values = [];

  if (min_amount_per_point !== undefined) {
    fields.push("min_amount_per_point = ?");
    values.push(min_amount_per_point);
  }

  if (point_to_award !== undefined) {
    fields.push("point_to_award = ?");
    values.push(point_to_award);
  }

  if (is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(is_active ? 1 : 0);
  }

  if (fields.length === 0) {
    // nothing to update
    return await getPointRuleById(point_id);
  }

  const sql = `
    UPDATE point_system
    SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE point_id = ?
  `;
  values.push(point_id);

  const [result] = await pool.query(sql, values);

  if (result.affectedRows === 0) {
    return null;
  }

  return await getPointRuleById(point_id);
}

/**
 * Delete a point rule by id
 */
async function deletePointRule(point_id) {
  const [result] = await pool.query(
    `DELETE FROM point_system WHERE point_id = ?`,
    [point_id]
  );

  return result.affectedRows > 0;
}

module.exports = {
  getAllPointRules,
  getPointRuleById,
  createPointRule,
  updatePointRule,
  deletePointRule,
};
