// models/foodDiscoveryModel.js
const db = require("../config/db");

/**
 * Flow:
 * 1) Validate the :business_type_id exists and belongs to FOOD
 * 2) merchant_business_types → collect all business_id for that business_type_id
 * 3) merchant_business_details
 *    LEFT JOIN food_menu (by business_id)
 *    LEFT JOIN food_menu_ratings (by menu_id)
 *    → aggregated avg_rating + total_comments per business
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

  // 2) business_ids mapped to that type
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
        kind: "food",
        business_type_id: btId,
        business_type_name: bt.name,
        businesses_count: 0,
      },
    };
  }

  const bizIds = mapRows.map((r) => r.business_id);
  const placeholders = bizIds.map(() => "?").join(",");

  // 3) Fetch business details + aggregates from food_menu_ratings (per product)
  const [bizRows] = await db.query(
    `
    SELECT
      mbd.business_id,
      mbd.business_name,
      mbd.address,
      mbd.business_logo,
      mbd.opening_time,
      mbd.closing_time,
      mbd.delivery_option,
      mbd.complementary,
      mbd.complementary_details,
      mbd.latitude,
      mbd.longitude,
      -- averages/counts based on menu-item ratings
      COALESCE(ROUND(AVG(fmr.rating), 2), 0) AS avg_rating,
      SUM(CASE WHEN fmr.comment IS NOT NULL AND fmr.comment <> '' THEN 1 ELSE 0 END) AS total_comments
    FROM merchant_business_details mbd
    LEFT JOIN food_menu fm
      ON fm.business_id = mbd.business_id
    LEFT JOIN food_menu_ratings fmr
      ON fmr.menu_id = fm.id
    WHERE mbd.business_id IN (${placeholders})
    GROUP BY
      mbd.business_id, mbd.business_name, mbd.address, mbd.business_logo,
      mbd.opening_time, mbd.closing_time, mbd.delivery_option,
      mbd.complementary, mbd.complementary_details,
      mbd.latitude, mbd.longitude
    ORDER BY avg_rating DESC, total_comments DESC, mbd.business_name ASC
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
