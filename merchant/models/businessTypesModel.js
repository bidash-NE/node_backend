// models/businessTypesModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

// ===== helpers =====
const bhutanNow = () => moment.tz("Asia/Thimphu").format("YYYY-MM-DD HH:mm:ss");

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
// allow array or string; normalize commas & spaces -> "a,b,c"
function normalizeTypes(input) {
  if (input == null) return null;
  if (Array.isArray(input)) {
    return input
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join(",");
  }
  return (
    String(input)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(",") || null
  );
}

// Log admin action into admin_logs with Bhutan time; never throw
async function logAdminAction(user_id, admin_name, activity) {
  try {
    let uid = toIntOrNull(user_id);
    if (uid) {
      const [chk] = await db.query(
        `SELECT 1 FROM users WHERE user_id = ? LIMIT 1`,
        [uid]
      );
      if (chk.length === 0) uid = null;
    }
    await db.query(
      `INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
       VALUES (?, ?, ?, ?)`,
      [uid, toStrOrNull(admin_name), toStrOrNull(activity), bhutanNow()]
    );
  } catch (e) {
    console.warn("admin_logs insert failed:", e.message);
  }
}

// ===== queries =====

// List all business types
async function getAllBusinessTypes() {
  const [rows] = await db.query(
    `SELECT id, name, description, types FROM business_types ORDER BY name ASC`
  );
  if (!rows.length)
    return { success: false, message: "No business types found.", data: [] };
  return { success: true, data: rows };
}

// Get one by id
async function getBusinessTypeById(id) {
  const [rows] = await db.query(
    `SELECT id, name, description, types FROM business_types WHERE id = ?`,
    [id]
  );
  if (!rows.length)
    return {
      success: false,
      message: `Business type with ID ${id} not found.`,
    };
  return { success: true, data: rows[0] };
}

// Get by token in `types` (comma-separated). Case-insensitive, space-agnostic.
async function getBusinessTypesByType(typeToken) {
  const token = String(typeToken || "")
    .toLowerCase()
    .trim();
  if (!token) return { success: false, message: "Type is required.", data: [] };

  // Match token within comma-separated list safely
  const likePattern = `%,${token},%`;
  const [rows] = await db.query(
    `SELECT id, name, description, types
     FROM business_types
     WHERE types IS NOT NULL
       AND LOWER(CONCAT(',', REPLACE(types, ' ', ''), ',')) LIKE ?`,
    [likePattern]
  );

  if (!rows.length) {
    return {
      success: false,
      message: `No business types found for type "${token}".`,
      data: [],
    };
  }
  return { success: true, data: rows };
}

// Create
async function addBusinessType(name, description, types, user_id, admin_name) {
  const n = toStrOrNull(name);
  const d = toStrOrNull(description);
  const t = normalizeTypes(types);
  if (!n) return { success: false, message: "Name is required." };

  // unique name
  const [dups] = await db.query(
    `SELECT 1 FROM business_types WHERE name = ? LIMIT 1`,
    [n]
  );
  if (dups.length)
    return { success: false, message: `Business type "${n}" already exists.` };

  const now = bhutanNow();
  const [res] = await db.query(
    `INSERT INTO business_types (name, description, types, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [n, d, t, now, now]
  );

  await logAdminAction(
    user_id,
    admin_name,
    `CREATE: Added business type "${n}" (types: ${t || "-"})`
  );
  return {
    success: true,
    message: `Business type "${n}" added successfully.`,
    insertedId: res.insertId,
  };
}

// Update
async function updateBusinessType(
  id,
  name,
  description,
  types,
  user_id,
  admin_name
) {
  const existing = await getBusinessTypeById(id);
  if (!existing.success) return { success: false, message: existing.message };

  const n = toStrOrNull(name);
  const d = toStrOrNull(description);
  const t = normalizeTypes(types);
  if (!n) return { success: false, message: "Name is required." };

  const now = bhutanNow();
  await db.query(
    `UPDATE business_types SET name = ?, description = ?, types = ?, updated_at = ? WHERE id = ?`,
    [n, d, t, now, id]
  );

  await logAdminAction(
    user_id,
    admin_name,
    `UPDATE: Updated business type "${n}" (id: ${id}, types: ${t || "-"})`
  );
  return {
    success: true,
    message: `Business type "${n}" updated successfully.`,
  };
}

// Delete
async function deleteBusinessType(id, user_id, admin_name) {
  const bt = await getBusinessTypeById(id);
  if (!bt.success) return { success: false, message: bt.message };

  await db.query(`DELETE FROM business_types WHERE id = ?`, [id]);
  await logAdminAction(
    user_id,
    admin_name,
    `DELETE: Deleted business type "${bt.data.name}" (id: ${id})`
  );
  return {
    success: true,
    message: `Business type "${bt.data.name}" deleted successfully.`,
  };
}

module.exports = {
  getAllBusinessTypes,
  getBusinessTypeById,
  getBusinessTypesByType,
  addBusinessType,
  updateBusinessType,
  deleteBusinessType,
};
