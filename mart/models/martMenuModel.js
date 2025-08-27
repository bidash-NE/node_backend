const db = require("../config/db");
const moment = require("moment-timezone");

const bhutanNow = () => moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");

const toStrOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const toNumOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toBool01 = (v, def = 0) => {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return 1;
    if (["0", "false", "no", "off"].includes(s)) return 0;
  }
  return v ? 1 : 0;
};
const toBizId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("business_id must be a positive integer");
  return n;
};

async function assertBusinessExists(business_id) {
  const [r] = await db.query(
    `SELECT business_id FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
    [business_id]
  );
  if (!r.length) throw new Error(`business_id ${business_id} does not exist`);
}

async function getMerchantMartTypeNames(business_id) {
  const [rows] = await db.query(
    `SELECT DISTINCT bt.name
       FROM merchant_business_types mbt
       JOIN business_types bt ON bt.id = mbt.business_type_id
      WHERE mbt.business_id = ?
        AND LOWER(bt.types) = 'mart'`,
    [business_id]
  );
  return rows.map((r) => String(r.name).trim()).filter(Boolean);
}

async function getMartCategoryByName(category_name) {
  const [rows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image
       FROM mart_category
      WHERE LOWER(category_name) = LOWER(?)
      LIMIT 1`,
    [category_name]
  );
  return rows[0] || null;
}

async function assertCategoryAllowedForBusiness(business_id, category_name) {
  const catRow = await getMartCategoryByName(category_name);
  if (!catRow) {
    throw new Error(
      `Category "${category_name}" does not exist in mart_category`
    );
  }
  const martTypes = await getMerchantMartTypeNames(business_id);
  if (!martTypes.length) {
    throw new Error(
      `Business ${business_id} is not registered under any MART business type`
    );
  }
  const allowed = martTypes
    .map((n) => n.toLowerCase())
    .includes(String(catRow.business_type).toLowerCase());
  if (!allowed) {
    throw new Error(
      `Category "${category_name}" belongs to business_type "${catRow.business_type}", which this business (${business_id}) is not registered for`
    );
  }
  return catRow;
}

async function assertUniquePerBusinessCategory(
  business_id,
  category_name,
  item_name,
  excludeId = null
) {
  const sql = `
    SELECT id FROM mart_menu
     WHERE business_id = ?
       AND LOWER(category_name) = LOWER(?)
       AND LOWER(item_name) = LOWER(?)
     ${excludeId ? "AND id <> ?" : ""}
     LIMIT 1`;
  const params = excludeId
    ? [business_id, category_name, item_name, excludeId]
    : [business_id, category_name, item_name];
  const [rows] = await db.query(sql, params);
  if (rows.length) {
    throw new Error(
      `item "${item_name}" already exists in category "${category_name}" for business_id ${business_id}`
    );
  }
}

async function createMartMenuItem(payload) {
  const {
    business_id,
    category_name,
    item_name,
    description,
    item_image,
    actual_price,
    discount_percentage,
    tax_rate,
    is_veg,
    spice_level,
    is_available,
    stock_limit,
    sort_order,
  } = payload;

  const bizId = toBizId(business_id);
  await assertBusinessExists(bizId);

  const cat = toStrOrNull(category_name);
  if (!cat) throw new Error("category_name is required");

  await assertCategoryAllowedForBusiness(bizId, cat);

  const name = toStrOrNull(item_name);
  if (!name) throw new Error("item_name is required");

  await assertUniquePerBusinessCategory(bizId, cat, name);

  const desc = toStrOrNull(description);
  const img = toStrOrNull(item_image);

  const price = toNumOrNull(actual_price);
  if (price === null) throw new Error("actual_price must be a valid number");

  const discount = toNumOrNull(discount_percentage) ?? 0;
  const tax = toNumOrNull(tax_rate) ?? 0;
  const veg = toBool01(is_veg, 0);
  const spice = toStrOrNull(spice_level) || "None";
  if (!["None", "Mild", "Medium", "Hot"].includes(spice))
    throw new Error("spice_level must be one of: None, Mild, Medium, Hot");
  const available = toBool01(is_available, 1);
  const stock = Number.isInteger(Number(stock_limit)) ? Number(stock_limit) : 0;
  const sort = Number.isInteger(Number(sort_order)) ? Number(sort_order) : 0;

  const now = bhutanNow();

  const [res] = await db.query(
    `INSERT INTO mart_menu
      (business_id, category_name, item_name, description, item_image,
       actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
       stock_limit, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bizId,
      cat,
      name,
      desc,
      img,
      price,
      discount,
      tax,
      veg,
      spice,
      available,
      stock,
      sort,
      now,
      now,
    ]
  );

  const item = await getMartMenuItemById(res.insertId);
  return { success: true, message: "Mart menu item created.", data: item.data };
}

async function getMartMenuItemById(id) {
  const [rows] = await db.query(
    `SELECT id, business_id, category_name, item_name, description, item_image,
            actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
            stock_limit, sort_order, created_at, updated_at
       FROM mart_menu
      WHERE id = ?`,
    [id]
  );
  if (!rows.length)
    return { success: false, message: `Mart menu item id ${id} not found.` };
  return { success: true, data: rows[0] };
}

async function listMartMenuItems({ business_id, category_name } = {}) {
  const parts = [];
  const params = [];
  if (business_id !== undefined) {
    const bid = toBizId(business_id);
    parts.push("business_id = ?");
    params.push(bid);
  }
  if (category_name) {
    parts.push("LOWER(category_name) = LOWER(?)");
    params.push(category_name);
  }
  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const [rows] = await db.query(
    `SELECT id, business_id, category_name, item_name, description, item_image,
            actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
            stock_limit, sort_order, created_at, updated_at
       FROM mart_menu
       ${where}
      ORDER BY sort_order ASC, item_name ASC`,
    params
  );
  return { success: true, data: rows };
}

async function listMartMenuByBusiness(business_id) {
  const bid = toBizId(business_id);
  const [rows] = await db.query(
    `SELECT id, business_id, category_name, item_name, description, item_image,
            actual_price, discount_percentage, tax_rate, is_veg, spice_level, is_available,
            stock_limit, sort_order, created_at, updated_at
       FROM mart_menu
      WHERE business_id = ?
      ORDER BY category_name ASC, sort_order ASC, item_name ASC`,
    [bid]
  );
  return { success: true, data: rows };
}

async function updateMartMenuItem(id, fields) {
  const existing = await getMartMenuItemById(id);
  if (!existing.success) return existing;
  const prev = existing.data;

  const updates = {};

  if ("business_id" in fields) {
    const bid = toBizId(fields.business_id);
    await assertBusinessExists(bid);
    updates.business_id = bid;
  }

  if ("category_name" in fields) {
    const cat = toStrOrNull(fields.category_name);
    if (!cat) throw new Error("category_name cannot be empty");
    updates.category_name = cat;
  }

  if ("item_name" in fields) {
    const n = toStrOrNull(fields.item_name);
    if (!n) throw new Error("item_name cannot be empty");
    updates.item_name = n;
  }

  if ("description" in fields)
    updates.description = toStrOrNull(fields.description);
  if ("item_image" in fields)
    updates.item_image = toStrOrNull(fields.item_image);

  if ("actual_price" in fields) {
    const price = toNumOrNull(fields.actual_price);
    if (price === null) throw new Error("actual_price must be a valid number");
    updates.actual_price = price;
  }

  if ("discount_percentage" in fields) {
    const disc = toNumOrNull(fields.discount_percentage);
    if (disc === null)
      throw new Error("discount_percentage must be a valid number");
    updates.discount_percentage = disc;
  }

  if ("tax_rate" in fields) {
    const tax = toNumOrNull(fields.tax_rate);
    if (tax === null) throw new Error("tax_rate must be a valid number");
    updates.tax_rate = tax;
  }

  if ("is_veg" in fields) updates.is_veg = toBool01(fields.is_veg);

  if ("spice_level" in fields) {
    const spice = toStrOrNull(fields.spice_level);
    if (spice && !["None", "Mild", "Medium", "Hot"].includes(spice))
      throw new Error("spice_level must be one of: None, Mild, Medium, Hot");
    updates.spice_level = spice || "None";
  }

  if ("is_available" in fields)
    updates.is_available = toBool01(fields.is_available);
  if ("stock_limit" in fields)
    updates.stock_limit = Number.isInteger(Number(fields.stock_limit))
      ? Number(fields.stock_limit)
      : 0;

  if ("sort_order" in fields)
    updates.sort_order = Number.isInteger(Number(fields.sort_order))
      ? Number(fields.sort_order)
      : 0;

  const finalBiz = updates.business_id ?? prev.business_id;
  const finalCat = updates.category_name ?? prev.category_name;
  const finalName = updates.item_name ?? prev.item_name;

  await assertCategoryAllowedForBusiness(finalBiz, finalCat);
  await assertUniquePerBusinessCategory(finalBiz, finalCat, finalName, id);

  const setClauses = [];
  const params = [];
  for (const [k, v] of Object.entries(updates)) {
    setClauses.push(`${k} = ?`);
    params.push(v);
  }
  if (!setClauses.length) {
    return {
      success: true,
      message: "No changes.",
      data: prev,
      old_image: prev.item_image,
      new_image: prev.item_image,
    };
  }
  setClauses.push("updated_at = ?");
  params.push(bhutanNow(), id);

  await db.query(
    `UPDATE mart_menu SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  const nowData = await getMartMenuItemById(id);
  return {
    success: true,
    message: "Mart menu item updated successfully.",
    data: nowData.data,
    old_image: prev.item_image,
    new_image: nowData.data.item_image,
  };
}

async function deleteMartMenuItem(id) {
  const existing = await getMartMenuItemById(id);
  if (!existing.success) return existing;
  await db.query(`DELETE FROM mart_menu WHERE id = ?`, [id]);
  return {
    success: true,
    message: "Mart menu item deleted successfully.",
    old_image: existing.data.item_image || null,
  };
}

module.exports = {
  createMartMenuItem,
  getMartMenuItemById,
  listMartMenuItems,
  listMartMenuByBusiness,
  updateMartMenuItem,
  deleteMartMenuItem,
};
