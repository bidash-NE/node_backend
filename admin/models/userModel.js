// models/userModel.js
const db = require("../config/db");

/**
 * Verify (user_id, admin_name) belongs to an admin/superadmin.
 * Uses users.user_name (your schema) and also accepts users.email.
 */
async function findPrivilegedByIdAndName(user_id, admin_name) {
  const roles = ["admin", "superadmin", "super admin", "super-admin"];

  const [rows] = await db.query(
    `
    SELECT user_id, user_name, email, role
      FROM users
     WHERE user_id = ?
       AND (user_name = ? OR email = ?)
       AND role IN (${roles.map(() => "?").join(",")})
     LIMIT 1
    `,
    [user_id, admin_name, admin_name, ...roles]
  );

  return rows[0] || null;
}

module.exports = { findPrivilegedByIdAndName };
