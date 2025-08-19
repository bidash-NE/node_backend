// models/categoryModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

/* ========== helpers ========== */
const bhutanNow = () => moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

const TABLE_BY_KIND = {
  food: "food_category",
  mart: "mart_category",
};

function tableForKind(kind) {
  const k = String(kind || "").toLowerCase();
  const t = TABLE_BY_KIND[k];
  if (!t) throw new Error("Invalid kind; must be 'food' or 'mart'");
  return t;
}

/** Verify admin identity: user exists and user_name matches admin_name (case-insensitive). */
async function verifyAdmin(user_id, admin_name) {
  if (!user_id || !admin_name) {
    throw new Error("admin verification failed: user_id and admin_name are required");
  }
  const [rows] = await db.query(
    `SELECT user_id, user_name FROM users WHERE user_id = ? LIMIT 1`,
    [user_id]
  );
  if (!rows.length) {
    throw new Error("admin verification failed: user not found");
  }
  const matches = rows[0].user_name?.toLowerCase() === String(admin_name).toLowerCase();
  if (!matches) {
    throw new Error("admin verification failed: admin_name does not match user");
  }
  return rows[0];
}

/** Resolve business type by NAME; ensure its 'types' matches :kind (food|mart). */
async function resolveBusinessTypeByNameOrThrow(kind, business_type_name) {
  const name = String(business_type_name || "").trim();
  if (!name) throw new Error("business_type (name) is required");
  const k = String(kind).toLowerCase();

  const [rows] = await db.query(
    `SELECT id, name, types
       FROM business_types
      WHERE LOWER(name) = LOWER(?)
        AND (types IS NULL OR LOWER(types) = ?) 
      LIMIT 1`,
    [name, k]
  );
  if (!rows.length) {
    throw new Error(`business_type "${name}" not found for kind "${k}"`);
  }
  return rows[0]; // {id, name, types}
}

/** admin_logs write; never throws */
async function logAdminActionSafe(user_id, admin_name, activity) {
  try {
    await db.query(
      `INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
       VALUES (?, ?, ?, ?)`,
      [user_id || null, toStrOrNull(admin_name), toStrOrNull(activity), bhutanNow()]
    );
  } catch (e) {
    console.warn("admin_logs insert failed:", e.message);
  }
}

/* ========== queries ========== */

// List all (ordered by name)
async function getAllCategories(kind) {
  const table = tableForKind(kind);
  const [rows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image, created_at, updated_at
       FROM ${table}
      ORDER BY category_name ASC`
  );
  if (!rows.length)
    return { success: false, message: "No categories found.", data: [] };
  return { success: true, data: rows };
}

// Get one by id
async function getCategoryById(kind, id) {
  const table = tableForKind(kind);
  const [rows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image, created_at, updated_at
       FROM ${table}
      WHERE id = ?`,
    [id]
  );
  if (!rows.length)
    return { success: false, message: `Category (kind=${kind}) id ${id} not found.` };
  return { success: true, data: rows[0] };
}

// Get by business_type (name) within kind
async function getCategoriesByBusinessType(kind, business_type_name) {
  const table = tableForKind(kind);
  const name = String(business_type_name || "").trim();
  if (!name) {
    return { success: false, message: "business_type (name) is required", data: [] };
  }
  // exact case-insensitive match on the stored name in category.business_type
  const [rows] = await db.query(
    `SELECT id, category_name, business_type, description, category_image, created_at, updated_at
       FROM ${table}
      WHERE LOWER(business_type) = LOWER(?)
      ORDER BY category_name ASC`,
    [name]
  );
  if (!rows.length)
    return {
      success: false,
      message: `No categories found for business_type "${name}" in ${table}.`,
      data: [],
    };
  return { success: true, data: rows };
}

/* ========== create / update / delete with verifications and admin_logs ========== */

// Create (requires valid admin + valid business_type name)
async function addCategory(kind, { category_name, business_type, description, category_image }, user_id, admin_name) {
  const table = tableForKind(kind);

  // 1) verify admin
  await verifyAdmin(user_id, admin_name);

  // 2) verify business_type name exists and matches kind
  const btRow = await resolveBusinessTypeByNameOrThrow(kind, business_type || kind);

  const name = toStrOrNull(category_name);
  const desc = toStrOrNull(description);
  const img = toStrOrNull(category_image);

  if (!name) return { success: false, message: "category_name is required." };

  // uniqueness: (business_type NAME, category_name)
  const [dups] = await db.query(
    `SELECT 1 FROM ${table}
      WHERE LOWER(business_type) = LOWER(?) AND LOWER(category_name) = LOWER(?)
      LIMIT 1`,
    [btRow.name, name]
  );
  if (dups.length) {
    return {
      success: false,
      message: `Category "${name}" already exists for business_type "${btRow.name}".`,
    };
  }

  const now = bhutanNow();
  const [res] = await db.query(
    `INSERT INTO ${table} (category_name, business_type, description, category_image, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, btRow.name, desc, img, now, now]
  );

  await logAdminActionSafe(
    user_id,
    admin_name,
    `CREATE ${table}: "${name}" (business_type="${btRow.name}", kind=${btRow.types || kind}, image=${img || "-"})`
  );

  const created = await getCategoryById(kind, res.insertId);
  return {
    success: true,
    message: `Category "${name}" created successfully.`,
    data: created.success ? created.data : { id: res.insertId, category_name: name, business_type: btRow.name, description: desc, category_image: img },
  };
}

// Update (partial) — verifies admin, and if business_type provided, it must exist by name
async function updateCategory(kind, id, { category_name, business_type, description, category_image }, user_id, admin_name) {
  const table = tableForKind(kind);

  // verify admin
  await verifyAdmin(user_id, admin_name);

  const existing = await getCategoryById(kind, id);
  if (!existing.success) return { success: false, message: existing.message };
  const prev = existing.data;

  let btNameToStore;
  if (business_type !== undefined) {
    // if provided, re-verify it
    const btRow = await resolveBusinessTypeByNameOrThrow(kind, business_type);
    btNameToStore = btRow.name;
  }

  const name = category_name !== undefined ? toStrOrNull(category_name) : undefined;
  const desc = description !== undefined ? toStrOrNull(description) : undefined;
  const img  = category_image !== undefined ? toStrOrNull(category_image) : undefined;

  if (name === null) return { success: false, message: "category_name cannot be empty." };

  // uniqueness check when either name or business_type changes
  const finalName = name !== undefined ? name : prev.category_name;
  const finalBT   = btNameToStore !== undefined ? btNameToStore : prev.business_type;

  if (finalName && finalBT) {
    const [dups] = await db.query(
      `SELECT 1 FROM ${table}
         WHERE LOWER(business_type) = LOWER(?) AND LOWER(category_name) = LOWER(?) AND id <> ?
         LIMIT 1`,
      [finalBT, finalName, id]
    );
    if (dups.length) {
      return {
        success: false,
        message: `Another category "${finalName}" already exists for business_type "${finalBT}".`,
      };
    }
  }

  const sets = [];
  const params = [];
  const setIf = (col, val) => {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  };

  setIf("category_name", name);
  setIf("business_type", btNameToStore);
  setIf("description", desc);
  setIf("category_image", img);

  if (!sets.length) {
    return { success: true, message: "No changes.", data: prev, old_image: prev.category_image, new_image: prev.category_image };
  }

  sets.push("updated_at = ?");
  params.push(bhutanNow(), id);

  await db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, params);

  const updated = await getCategoryById(kind, id);

  await logAdminActionSafe(
    user_id,
    admin_name,
    `UPDATE ${table}: id=${id} "${finalName}" (business_type="${finalBT}", image=${img !== undefined ? (img || "-") : "(unchanged)"})`
  );

  return {
    success: true,
    message: "Category updated successfully.",
    data: updated.success ? updated.data : null,
    old_image: prev.category_image,
    new_image: updated.success ? updated.data.category_image : prev.category_image,
  };
}

// Delete — verifies admin
async function deleteCategory(kind, id, user_id, admin_name) {
  const table = tableForKind(kind);

  // verify admin
  await verifyAdmin(user_id, admin_name);

  const cat = await getCategoryById(kind, id);
  if (!cat.success) return { success: false, message: cat.message };

  await db.query(`DELETE FROM ${table} WHERE id = ?`, [id]);

  await logAdminActionSafe(
    user_id,
    admin_name,
    `DELETE ${table}: id=${id} "${cat.data.category_name}" (business_type="${cat.data.business_type}")`
  );

  return {
    success: true,
    message: `Category "${cat.data.category_name}" deleted successfully.`,
    old_image: cat.data.category_image || null,
  };
}

module.exports = {
  getAllCategories,
  getCategoryById,
  getCategoriesByBusinessType,
  addCategory,
  updateCategory,
  deleteCategory,
};
