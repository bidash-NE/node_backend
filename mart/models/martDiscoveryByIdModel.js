// models/martDiscoveryByIdModel.js
const db = require("../config/db");

/**
 * Discovery by business_type_id (MART):
 * 1) Validate business_types.id exists and types='mart'
 * 2) merchant_business_types: find business_id for that business_type_id
 * 3) merchant_business_details: fetch businesses
 */
async function getMartBusinessesByBusinessTypeId(business_type_id) {
  const btId = Number(business_type_id);
  if (!Number.isInteger(btId) || btId <= 0) {
    throw new Error("business_type_id must be a positive integer");
  }

  const [btRows] = await db.query(
    `SELECT id, name, types FROM business_types WHERE id = ? LIMIT 1`,
    [btId]
  );
  if (!btRows.length)
    return { success: false, message: `business_type_id ${btId} not found` };
  const bt = btRows[0];
  if (String(bt.types).toLowerCase() !== "mart") {
    return {
      success: false,
      message: `business_type_id ${btId} is not of type 'mart'`,
    };
  }

  const [linkRows] = await db.query(
    `SELECT DISTINCT business_id
       FROM merchant_business_types
      WHERE business_type_id = ?`,
    [btId]
  );
  if (!linkRows.length) {
    return {
      success: true,
      data: [],
      meta: { business_type_id: btId, business_type_name: bt.name, count: 0 },
    };
  }
  const ids = linkRows.map((r) => r.business_id);
  const ph = ids.map(() => "?").join(",");

  const [bizRows] = await db.query(
    `SELECT business_id, user_id, business_name, owner_type, address, business_logo,
            latitude, longitude, delivery_option, opening_time, closing_time, holidays,
            created_at, updated_at
       FROM merchant_business_details
      WHERE business_id IN (${ph})
      ORDER BY business_name ASC`,
    ids
  );

  return {
    success: true,
    data: bizRows,
    meta: {
      business_type_id: btId,
      business_type_name: bt.name,
      count: bizRows.length,
    },
  };
}

module.exports = { getMartBusinessesByBusinessTypeId };
