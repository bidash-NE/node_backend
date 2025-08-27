// models/foodMenuBrowseModel.js
const db = require("../config/db");

function toBizIdOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("business_id must be a positive integer");
  return n;
}

async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error(`business_id ${business_id} does not exist`);
}

/**
 * Flow:
 * 1) From business → merchant_business_types → business_types (types='food') → names
 * 2) From food_category: categories whose business_type IN (those names)
 * 3) From food_menu: all items for this business across those categories
 * 4) Group items under their category
 * 5) Exclude categories with zero items
 */
async function getFoodMenuGroupedByCategoryForBusiness(business_id) {
  const bid = toBizIdOrThrow(business_id);
  await assertBusinessExists(bid);

  // 1) business_type names (FOOD only) for this business
  const [btRows] = await db.query(
    `SELECT DISTINCT bt.id, bt.name
       FROM merchant_business_types mbt
       JOIN business_types bt
         ON bt.id = mbt.business_type_id
      WHERE mbt.business_id = ?
        AND LOWER(bt.types) = 'food'`,
    [bid]
  );
  if (!btRows.length) {
    return {
      success: true,
      data: [],
      meta: { business_id: bid, categories_count: 0, items_count: 0 },
    };
  }
  const btNames = btRows.map((r) => r.name);

  // 2) categories from food_category for those business_type names
  const placeholders = btNames.map(() => "?").join(",");
  const [catRows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image
       FROM food_category
      WHERE LOWER(business_type) IN (${placeholders})
      ORDER BY category_name ASC`,
    btNames.map((n) => n.toLowerCase())
  );
  if (!catRows.length) {
    return {
      success: true,
      data: [],
      meta: { business_id: bid, categories_count: 0, items_count: 0 },
    };
  }
  const catNames = catRows.map((c) => c.category_name);

  // 3) fetch all menu items for this business across those category names
  const catPh = catNames.map(() => "?").join(",");
  const [itemRows] = await db.query(
    `SELECT id, business_id, category_name, item_name, description, item_image,
            actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
            stock_limit, sort_order, created_at, updated_at
       FROM food_menu
      WHERE business_id = ?
        AND LOWER(category_name) IN (${catPh})
      ORDER BY sort_order ASC, item_name ASC`,
    [bid, ...catNames.map((n) => n.toLowerCase())]
  );

  // 4) group items under categories
  const itemsByCat = new Map();
  for (const it of itemRows) {
    const key = String(it.category_name || "").toLowerCase();
    if (!itemsByCat.has(key)) itemsByCat.set(key, []);
    itemsByCat.get(key).push(it);
  }

  const grouped = catRows.map((cat) => {
    const key = String(cat.category_name || "").toLowerCase();
    return {
      category_id: cat.id,
      category_name: cat.category_name,
      business_type: cat.business_type,
      category_image: cat.category_image,
      description: cat.description,
      items: itemsByCat.get(key) || [],
    };
  });

  // 5) exclude categories with zero items
  const groupedNonEmpty = grouped.filter((g) => g.items && g.items.length > 0);

  return {
    success: true,
    data: groupedNonEmpty,
    meta: {
      business_id: bid,
      categories_count: groupedNonEmpty.length,
      items_count: itemRows.length,
    },
  };
}

module.exports = {
  getFoodMenuGroupedByCategoryForBusiness,
};
