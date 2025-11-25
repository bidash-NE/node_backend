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
    `SELECT business_id, min_amount_for_fd
       FROM merchant_business_details
      WHERE business_id = ?
      LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error(`business_id ${business_id} does not exist`);
  return r[0]; // return so we can use min_amount_for_fd
}

/**
 * New flow (robust to name/case/space mismatches):
 * 1) Pull ALL items for this business (source of truth).
 * 2) Build distinct normalized category keys from items.
 * 3) Enrich with food_category (best-effort) via case/space-insensitive match.
 * 4) Group items under their categories; exclude only if NO items (never happens here).
 */
async function getFoodMenuGroupedByCategoryForBusiness(business_id) {
  const bid = toBizIdOrThrow(business_id);

  // Get business row (also has min_amount_for_fd)
  const bizRow = await assertBusinessExists(bid);
  const minFD = Number(bizRow.min_amount_for_fd || 0);

  // 1) Fetch all items for this business
  const [itemRows] = await db.query(
    `SELECT id, business_id, category_name, item_name, description, item_image,
            actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
            stock_limit, sort_order, created_at, updated_at
       FROM food_menu
      WHERE business_id = ?
      ORDER BY sort_order ASC, item_name ASC`,
    [bid]
  );

  if (!itemRows.length) {
    return {
      success: true,
      data: [],
      meta: {
        business_id: bid,
        min_amount_for_fd: minFD,
        categories_count: 0,
        items_count: 0,
      },
    };
  }

  // 2) Distinct normalized category keys from items
  const norm = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase();
  const catKeyToOriginal = new Map(); // key -> first-seen original casing
  const catKeys = new Set();

  for (const it of itemRows) {
    const key = norm(it.category_name);
    if (!key) continue;
    if (!catKeyToOriginal.has(key))
      catKeyToOriginal.set(key, it.category_name || "");
    catKeys.add(key);
  }

  if (!catKeys.size) {
    // Items have no category_name at all — put them under "Uncategorized"
    return {
      success: true,
      data: [
        {
          category_id: null,
          category_name: "Uncategorized",
          business_type: null,
          category_image: null,
          description: null,
          items: itemRows,
        },
      ],
      meta: {
        business_id: bid,
        min_amount_for_fd: minFD,
        categories_count: 1,
        items_count: itemRows.length,
      },
    };
  }

  // 3) Enrich with food_category by case/space-insensitive name match
  const originals = Array.from(catKeyToOriginal.values());
  const ph = originals.map(() => "?").join(",");

  const [catRows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image
       FROM food_category
      WHERE LOWER(TRIM(category_name)) IN (${ph})`,
    originals.map((n) => n.trim().toLowerCase())
  );

  // Map: normalized category_name -> category metadata
  const catMetaByKey = new Map();
  for (const c of catRows) {
    catMetaByKey.set(norm(c.category_name), c);
  }

  // 4) Group items
  const groups = new Map(); // key -> { meta, items[] }
  for (const it of itemRows) {
    const key = norm(it.category_name) || "__uncategorized__";
    if (!groups.has(key)) {
      const meta = catMetaByKey.get(key);
      groups.set(key, {
        category_id: meta?.id ?? null,
        category_name:
          meta?.category_name ?? (catKeyToOriginal.get(key) || "Uncategorized"),
        business_type: meta?.business_type ?? null,
        category_image: meta?.category_image ?? null,
        description: meta?.description ?? null,
        items: [],
      });
    }
    groups.get(key).items.push(it);
  }

  // Stable order by category_name
  const grouped = Array.from(groups.values()).sort((a, b) =>
    String(a.category_name).localeCompare(String(b.category_name))
  );

  return {
    success: true,
    data: grouped,
    meta: {
      business_id: bid,
      min_amount_for_fd: minFD,
      categories_count: grouped.length,
      items_count: itemRows.length,
    },
  };
}

module.exports = {
  getFoodMenuGroupedByCategoryForBusiness,
};
