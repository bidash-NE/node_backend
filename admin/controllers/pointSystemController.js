// controllers/pointSystemController.js
const pointSystemModel = require("../models/pointSystemModel");
const pool = require("../config/db");

/**
 * Resolve admin identity (name + role label) from token and DB
 */
async function resolveAdminIdentity(req) {
  const u = req.user || {};
  const adminUserId = u.user_id || u.id || null;

  let tokenRole = u.role || null;
  let tokenName = u.admin_name || u.user_name || u.name || null;

  let dbName = null;
  let dbRole = null;

  // If we have user_id but no name, fetch from DB
  if (adminUserId && !tokenName) {
    try {
      const [rows] = await pool.query(
        `SELECT user_name, role FROM users WHERE user_id = ? LIMIT 1`,
        [adminUserId]
      );
      if (rows && rows.length > 0) {
        dbName = rows[0].user_name || null;
        dbRole = rows[0].role || null;
      }
    } catch (err) {
      console.error("Failed to fetch admin info from users table:", err);
    }
  }

  const finalName = tokenName || dbName || null;
  const rawRole = tokenRole || dbRole || "";

  // Normalize role label for logging
  const normalized = String(rawRole).trim().toLowerCase(); // e.g. 'super admin'
  const compact = normalized.replace(/[\s_]+/g, ""); // 'superadmin'

  let roleLabel = "Admin";
  if (compact === "superadmin") roleLabel = "Super admin";
  else if (normalized === "admin") roleLabel = "Admin";

  return {
    adminUserId,
    adminName: finalName,
    roleLabel,
  };
}

/**
 * Log admin action into admin_logs with clear message
 */
async function logAdminAction(req, actionDescription) {
  try {
    const { adminUserId, adminName, roleLabel } = await resolveAdminIdentity(
      req
    );

    let base;
    if (adminName && adminUserId) {
      base = `${roleLabel} "${adminName}" (id: ${adminUserId}) `;
    } else if (adminName) {
      base = `${roleLabel} "${adminName}" `;
    } else if (adminUserId) {
      base = `${roleLabel} (id: ${adminUserId}) `;
    } else {
      base = `${roleLabel} `;
    }

    const activity = `${base}${actionDescription}`;

    await pool.query(
      `
      INSERT INTO admin_logs (user_id, admin_name, activity, created_at)
      VALUES (?, ?, ?, UTC_TIMESTAMP())
      `,
      [adminUserId || null, adminName || null, activity]
    );
  } catch (err) {
    // Do not block main flow if logging fails
    console.error("Failed to write admin log (point_system):", err);
  }
}

// GET /point-system?onlyActive=true
exports.getAllPointRules = async (req, res) => {
  try {
    const onlyActive =
      String(req.query.onlyActive || "").toLowerCase() === "true";
    const rules = await pointSystemModel.getAllPointRules(onlyActive);

    return res.status(200).json({
      success: true,
      count: rules.length,
      data: rules,
    });
  } catch (err) {
    console.error("Error fetching point rules:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// GET /point-system/:id
exports.getPointRuleById = async (req, res) => {
  try {
    const { id } = req.params;

    const rule = await pointSystemModel.getPointRuleById(id);
    if (!rule) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    return res.status(200).json({
      success: true,
      data: rule,
    });
  } catch (err) {
    console.error("Error fetching point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// POST /point-system
// body: { min_amount_per_point, point_to_award, is_active? }
exports.createPointRule = async (req, res) => {
  try {
    const { min_amount_per_point, point_to_award, is_active } = req.body || {};

    // Basic validation
    if (min_amount_per_point === undefined || point_to_award === undefined) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point and point_to_award are required.",
      });
    }

    const minAmountNum = Number(min_amount_per_point);
    const pointsNum = Number(point_to_award);

    if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point must be a positive number.",
      });
    }

    if (!Number.isInteger(pointsNum) || pointsNum < 0) {
      return res.status(400).json({
        success: false,
        error: "point_to_award must be a non-negative integer.",
      });
    }

    const rule = await pointSystemModel.createPointRule({
      min_amount_per_point: minAmountNum,
      point_to_award: pointsNum,
      is_active: is_active !== undefined ? !!is_active : true,
    });

    // 🔐 log admin action with clear name & role
    await logAdminAction(
      req,
      `created point rule (id: ${rule.point_id}, min_amount_per_point: ${rule.min_amount_per_point}, point_to_award: ${rule.point_to_award}, is_active: ${rule.is_active})`
    );

    return res.status(201).json({
      success: true,
      message: "Point rule created successfully.",
      data: rule,
    });
  } catch (err) {
    console.error("Error creating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// PUT /point-system/:id
// body: { min_amount_per_point?, point_to_award?, is_active? }
exports.updatePointRule = async (req, res) => {
  try {
    const { id } = req.params;
    let { min_amount_per_point, point_to_award, is_active } = req.body || {};

    const updates = {};

    if (min_amount_per_point !== undefined) {
      const minAmountNum = Number(min_amount_per_point);
      if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
        return res.status(400).json({
          success: false,
          error: "min_amount_per_point must be a positive number.",
        });
      }
      updates.min_amount_per_point = minAmountNum;
    }

    if (point_to_award !== undefined) {
      const pointsNum = Number(point_to_award);
      if (!Number.isInteger(pointsNum) || pointsNum < 0) {
        return res.status(400).json({
          success: false,
          error: "point_to_award must be a non-negative integer.",
        });
      }
      updates.point_to_award = pointsNum;
    }

    if (is_active !== undefined) {
      updates.is_active = !!is_active;
    }

    const updated = await pointSystemModel.updatePointRule(id, updates);

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    // 🔐 log admin action with clear name & role
    await logAdminAction(
      req,
      `updated point rule (id: ${updated.point_id}, min_amount_per_point: ${updated.min_amount_per_point}, point_to_award: ${updated.point_to_award}, is_active: ${updated.is_active})`
    );

    return res.status(200).json({
      success: true,
      message: "Point rule updated successfully.",
      data: updated,
    });
  } catch (err) {
    console.error("Error updating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// DELETE /point-system/:id
exports.deletePointRule = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await pointSystemModel.deletePointRule(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    // 🔐 log admin action with clear name & role
    await logAdminAction(req, `deleted point rule (id: ${id})`);

    return res.status(200).json({
      success: true,
      message: "Point rule deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};
