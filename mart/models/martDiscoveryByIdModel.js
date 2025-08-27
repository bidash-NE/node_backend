const db = require("../config/db");

function toPositiveIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}

async function getMartBusinessesByBusinessTypeId(business_type_id) {
  const btId = toPositiveIntOrThrow(
    business_type_id,
    "business_type_id must be a positive integer"
  );

  const [btRows] = await db.query(
    `SELECT id, name, types FROM business_types WHERE id = ? LIMIT 1`,
    [btId]
  );
  if (!btRows.length) {
    return {
      success: false,
      message: `business_type_id ${btId} not found.`,
      data: [],
    };
  }
  const bt = btRows[0];
  if (String(bt.types || "").toLowerCase() !== "mart") {
    return {
      success: false,
      message: `business_type_id ${btId} is not a MART type.`,
      data: [],
    };
  }

  const [mapRows] = await db.query(
    `SELECT DISTINCT business_id FROM merchant_business_types WHERE business_type_id = ?`,
    [btId]
  );
  if (!mapRows.length) {
    return {
      success: true,
      data: [],
      meta: {
        kind: "mart",
        business_type_id: btId,
        business_type_name: bt.name,
        businesses_count: 0,
      },
    };
  }

  const bizIds = mapRows.map((r) => r.business_id);
  const placeholders = bizIds.map(() => "?").join(",");

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
      COALESCE(ROUND(AVG(mmr.rating), 2), 0) AS avg_rating,
      SUM(CASE WHEN mmr.comment IS NOT NULL AND mmr.comment <> '' THEN 1 ELSE 0 END) AS total_comments
    FROM merchant_business_details mbd
    LEFT JOIN mart_menu mm ON mm.business_id = mbd.business_id
    LEFT JOIN mart_menu_ratings mmr ON mmr.menu_id = mm.id
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
      kind: "mart",
      business_type_id: btId,
      business_type_name: bt.name,
      businesses_count: bizRows.length,
    },
  };
}

module.exports = { getMartBusinessesByBusinessTypeId };
