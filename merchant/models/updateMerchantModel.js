const db = require("../config/db");

async function updateMerchantBusinessDetails(business_id, updateFields) {
  const allowedFields = [
    "business_name",
    "latitude",
    "longitude",
    "address",
    "business_logo",
    "delivery_option",
    "complementary",
    "complementary_details",
    "opening_time",
    "closing_time",
    "holidays",
  ];

  const setClause = [];
  const values = [];

  for (const field of allowedFields) {
    if (updateFields[field] !== undefined) {
      // For holidays, ensure it's stored as JSON
      if (field === "holidays" && typeof updateFields[field] !== "string") {
        setClause.push(`\`${field}\` = CAST(? AS JSON)`);
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
    ", "
  )} WHERE business_id = ?`;
  const [result] = await db.query(sql, values);
  return result.affectedRows > 0;
}

async function getMerchantBusinessDetailsById(business_id) {
  const [rows] = await db.query(
    "SELECT * FROM merchant_business_details WHERE business_id = ?",
    [business_id]
  );
  return rows[0] || null;
}

module.exports = {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
};
