// models/updateMerchantModel.js
const db = require("../config/db");

async function updateMerchantBusinessDetails(business_id, updateFields) {
  const allowedFields = [
    "business_name",
    "latitude",
    "longitude",
    "address",
    "business_logo",
    "license_image",
    "delivery_option",
    "complementary",
    "complementary_details",
    "opening_time",
    "closing_time",
    "holidays",
    "special_celebration",
    "special_celebration_discount_percentage",
  ];

  const setClause = [];
  const values = [];

  for (const field of allowedFields) {
    if (updateFields[field] !== undefined) {
      if (field === "holidays" && Array.isArray(updateFields[field])) {
        setClause.push(`\`${field}\` = ?`);
        values.push(JSON.stringify(updateFields[field]));
      } else {
        setClause.push(`\`${field}\` = ?`);
        values.push(updateFields[field]);
      }
    }
  }

  if (setClause.length === 0) return false;

  values.push(business_id);

  const sql = `UPDATE merchant_business_details SET ${setClause.join(
    ", ",
  )} WHERE business_id = ?`;
  const [result] = await db.query(sql, values);
  return result.affectedRows > 0;
}

async function getMerchantBusinessDetailsById(business_id) {
  const [rows] = await db.query(
    "SELECT * FROM merchant_business_details WHERE business_id = ?",
    [business_id],
  );
  return rows[0] || null;
}

async function clearSpecialCelebrationByBusinessId(business_id) {
  const sql = `
    UPDATE merchant_business_details
    SET special_celebration = NULL,
        special_celebration_discount_percentage = NULL
    WHERE business_id = ?
  `;
  const [result] = await db.query(sql, [business_id]);
  return result.affectedRows > 0;
}

module.exports = {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
  clearSpecialCelebrationByBusinessId,
};
