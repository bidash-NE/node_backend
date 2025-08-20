// models/businessTypesModel.js
const db = require("../config/db");
const moment = require("moment-timezone");

/* ========== helpers ========== */
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

// allow array or CSV string; normalize to "a,b,c"
function normalizeTypes(input) {
  if (input == null) return null;
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter(Boolean).join(",");
  }
  return (
    String(input)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(",") || null
  );
}

/** Log admin action into admin_logs in Bhutan time; never throws */
async function logAdminAction(user_id, admin_name, activity) {
  try {
    // Optional: ensure user_id exists; if not, store NULL
    let uid = toIntOrNull(user_id);
    if (uid) {
      const [chk] = await db.query(`SELECT 1 FROM users WHERE user_id = ? LIMIT 1`, [uid]);
      if (!chk.length) uid = null;
    }
    await db.query(
      `INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
       VALUES (?, ?, ?, ?)`,
      [uid, toStrOrNull(admin_name), toStrOrNull(activity), bhutanNow()]
    );
  } catch (_e) {
    // swallow
  }
}

/* ========== queries used by controller ========== */

/** List all business types */
async function getAllBusinessTypes() {
  const [rows] = await db.query(
    `SELECT id, name, image, description, types, created_at, updated_at
       FROM business_types
      ORDER BY name ASC`
  );
  if (!rows.length) return { success: false, message: "No business types found.", data: [] };
  return { success: true, data: rows };
}

/** Get one by ID */
async function getBusinessTypeById(id) {
  const [rows] = await db.query(
    `SELECT id, name, image, description, types, created_at, updated_at
       FROM business_types
      WHERE id = ?`,
    [id]
  );
  if (!rows.length) {
    return { success: false, message: `Business type with ID ${id} not found.` };
  }
  return { success: true, data: rows[0] };
}

/** Get business types filtered by single token in 'types' (e.g., 'food' or 'mart') */
async function getBusinessTypesByType(typeToken) {
  const token = String(typeToken || "").toLowerCase().trim();
  if (!token) return { success: false, message: "Type is required.", data: [] };

  // If your schema stores a single token like 'food' or 'mart' in types,
  // equality is enough. If you sometimes store comma-separated values,
  // you can switch to the LIKE pattern shown in older versions.
  const [rows] = await db.query(
    `SELECT id, name, image, description, types, created_at, updated_at
       FROM business_types
      WHERE types IS NOT NULL
        AND LOWER(types) = ?`,
    [token]
  );

  if (!rows.length) {
    return { success: false, message: `No business types found for type "${token}".`, data: [] };
  }
  return { success: true, data: rows };
}

/** Create */
async function addBusinessType(name, description, types, image, user_id, admin_name) {
  const n = toStrOrNull(name);
  const d = toStrOrNull(description);
  // For your use-case, types should typically be 'food' or 'mart' (single token).
  // We still normalize to be tolerant of input format.
  const t = toStrOrNull(normalizeTypes(types));
  const img = toStrOrNull(image);

  if (!n) return { success: false, message: "Name is required." };

  // uniqueness: block duplicate (name + types) ignoring case
  const [dups] = await db.query(
    `SELECT 1 FROM business_types
      WHERE LOWER(name) = LOWER(?)
        AND (
             (types IS NULL AND ? IS NULL)
          OR LOWER(types) = LOWER(?)
        )
      LIMIT 1`,
    [n, t, t]
  );
  if (dups.length) {
    return {
      success: false,
      message: `Business type "${n}" with types "${t || "-"}" already exists.`,
    };
  }

  const now = bhutanNow();
  const [res] = await db.query(
    `INSERT INTO business_types (name, image, description, types, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [n, img, d, t, now, now]
  );

  await logAdminAction(
    user_id,
    admin_name,
    `CREATE business_types: "${n}" (types: ${t || "-"}, image: ${img || "-"})`
  );

  return {
    success: true,
    message: `Business type "${n}" added successfully.`,
    insertedId: res.insertId,
  };
}

/** Update */
async function updateBusinessType(id, name, description, types, image, user_id, admin_name) {
  const current = await getBusinessTypeById(id);
  if (!current.success) return current;

  const n = toStrOrNull(name);
  const d = toStrOrNull(description);
  const t = toStrOrNull(normalizeTypes(types));
  const img = toStrOrNull(image);

  if (!n) return { success: false, message: "Name is required." };

  // uniqueness check excluding current row
  const [dups] = await db.query(
    `SELECT 1 FROM business_types
      WHERE LOWER(name) = LOWER(?)
        AND (
             (types IS NULL AND ? IS NULL)
          OR LOWER(types) = LOWER(?)
        )
        AND id <> ?
      LIMIT 1`,
    [n, t, t, id]
  );
  if (dups.length) {
    return {
      success: false,
      message: `Another business type "${n}" with types "${t || "-"}" already exists.`,
    };
  }

  const now = bhutanNow();
  await db.query(
    `UPDATE business_types
        SET name = ?, image = ?, description = ?, types = ?, updated_at = ?
      WHERE id = ?`,
    [n, img, d, t, now, id]
  );

  await logAdminAction(
    user_id,
    admin_name,
    `UPDATE business_types: id=${id} -> name="${n}", types="${t || "-"}", image=${img || "-"}`
  );

  return { success: true, message: `Business type "${n}" updated successfully.` };
}

/** Delete */
async function deleteBusinessType(id, user_id, admin_name) {
  const bt = await getBusinessTypeById(id);
  if (!bt.success) return bt;

  await db.query(`DELETE FROM business_types WHERE id = ?`, [id]);

  await logAdminAction(
    user_id,
    admin_name,
    `DELETE business_types: id=${id} ("${bt.data.name}")`
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
