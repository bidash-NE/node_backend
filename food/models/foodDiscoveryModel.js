// models/foodDiscoveryModel.js
const db = require("../config/db");

/**
 * Flow:
 * 1) business_types: ensure the given :business_type_id exists AND types='food'
 * 2) merchant_business_types: collect all business_id for that business_type_id
 * 3) merchant_business_details: fetch distinct business rows
 */

function toPositiveIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}

async function getFoodBusinessesByBusinessTypeId(business_type_id) {
  const btId = toPositiveIntOrThrow(
    business_type_id,
    "business_type_id must be a positive integer"
  );

  // 1) Validate business_type id belongs to FOOD
  const [btRows] = await db.query(
    `SELECT id, name, types
       FROM business_types
      WHERE id = ?
      LIMIT 1`,
    [btId]
  );
  if (!btRows.length) {
    return {
      success: false,
      message: `business_type_id ${btId} not found in business_types.`,
      data: [],
    };
  }
  const bt = btRows[0];
  if (String(bt.types || "").toLowerCase() !== "food") {
    return {
      success: false,
      message: `business_type_id ${btId} is not a FOOD type.`,
      data: [],
    };
  }

  // 2) Get business_ids mapped to that type
  const [mapRows] = await db.query(
    `SELECT DISTINCT business_id
       FROM merchant_business_types
      WHERE business_type_id = ?`,
    [btId]
  );
  if (!mapRows.length) {
    return {
      success: true,
      data: [],
      meta: {
        business_type_id: btId,
        business_type_name: bt.name,
        businesses_count: 0,
      },
    };
  }

  const bizIds = mapRows.map((r) => r.business_id);
  const placeholders = bizIds.map(() => "?").join(",");

  // 3) Fetch business details
  const [bizRows] = await db.query(
    `
    SELECT
      mbd.business_id,
      mbd.business_name,
      mbd.address,
      mbd.business_logo,
      mbd.opening_time,
      mbd.closing_time,
      mbd.delivery_option
    FROM merchant_business_details mbd
    WHERE mbd.business_id IN (${placeholders})
    ORDER BY mbd.business_name ASC
    `,
    bizIds
  );

  return {
    success: true,
    data: bizRows,
    meta: {
      kind: "food",
      business_type_id: btId,
      business_type_name: bt.name,
      businesses_count: bizRows.length,
    },
  };
}

module.exports = {
  getFoodBusinessesByBusinessTypeId,
};
