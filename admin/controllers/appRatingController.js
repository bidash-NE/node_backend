// controllers/appRatingController.js
const db = require("../config/db");
const {
  createAppRating,
  getAppRatingById,
  listAppRatings,
  updateAppRating,
  deleteAppRating,
  getAppRatingSummary,
} = require("../models/appRatingModel");

/**
 * Helper: load admin user and verify role is admin/super-admin
 * Returns { admin_user_id, admin_name, role } or throws 403 error
 */
async function verifyAdminOrSuperAdmin(admin_user_id) {
  const idNum = Number(admin_user_id);
  if (!idNum || Number.isNaN(idNum)) {
    const err = new Error("Invalid admin_user_id");
    err.statusCode = 400;
    throw err;
  }

  const [rows] = await db.query(
    "SELECT user_id, user_name, role FROM users WHERE user_id = ? LIMIT 1",
    [idNum]
  );

  if (!rows.length) {
    const err = new Error("Admin user not found");
    err.statusCode = 404;
    throw err;
  }

  const admin = rows[0];
  const role = String(admin.role || "").toLowerCase();

  const allowedRoles = new Set(["admin", "super admin", "superadmin"]); // adjust if needed

  if (!allowedRoles.has(role)) {
    const err = new Error(
      "Not authorized. Only admin/super admin can perform this action."
    );
    err.statusCode = 403;
    throw err;
  }

  return {
    admin_user_id: admin.user_id,
    admin_name: admin.user_name || "UNKNOWN_ADMIN",
    role,
  };
}

/**
 * POST /api/app-ratings
 * Body: {
 *   user_id: number (required),
 *   rating: number (1–5),
 *   comment?: string,
 *   device_info?: {
 *     platform?: string,
 *     os_version?: string,
 *     app_version?: string,
 *     device_model?: string
 *   },
 *   network_type?: string
 * }
 */
async function createAppRatingController(req, res) {
  try {
    const body = req.body || {};

    const user_id = body.user_id ? Number(body.user_id) : null;
    const rating = Number(body.rating);

    if (!user_id || Number.isNaN(user_id)) {
      return res.status(400).json({
        success: false,
        message: "user_id is required and must be a valid number.",
      });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "rating must be between 1 and 5",
      });
    }

    const comment = body.comment || null;
    const deviceInfo = body.device_info || {};

    const platform = deviceInfo.platform || body.platform || null;
    const os_version = deviceInfo.os_version || body.os_version || null;
    const app_version = deviceInfo.app_version || body.app_version || null;
    const device_model = deviceInfo.device_model || body.device_model || null;

    const network_type = body.network_type || null;

    // Auto-fetch role from users table based on user_id (app user)
    let role = null;
    const [[userRow]] = await db.query(
      "SELECT role FROM users WHERE user_id = ? LIMIT 1",
      [user_id]
    );
    if (userRow && userRow.role) {
      role = userRow.role;
    }

    const created = await createAppRating({
      user_id,
      role,
      rating,
      comment,
      platform,
      os_version,
      app_version,
      device_model,
      network_type,
    });

    return res.status(201).json({
      success: true,
      message: "App rating submitted successfully.",
      data: created,
    });
  } catch (err) {
    console.error("Error creating app rating:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to submit app rating.",
    });
  }
}

/**
 * GET /api/app-ratings
 * Query: ?page=1&pageSize=20&min_rating=3&max_rating=5&platform=android&app_version=1.0.3
 */
async function listAppRatingsController(req, res) {
  try {
    const {
      page = "1",
      pageSize = "50",
      min_rating,
      max_rating,
      platform,
      app_version,
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.max(parseInt(pageSize, 10) || 50, 1);
    const offset = (pageNum - 1) * sizeNum;

    const filters = {
      minRating: min_rating != null ? Number(min_rating) : undefined,
      maxRating: max_rating != null ? Number(max_rating) : undefined,
      platform: platform || undefined,
      appVersion: app_version || undefined,
      limit: sizeNum,
      offset,
    };

    const rows = await listAppRatings(filters);

    return res.json({
      success: true,
      data: rows,
      meta: {
        page: pageNum,
        pageSize: sizeNum,
      },
    });
  } catch (err) {
    console.error("Error listing app ratings:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app ratings.",
    });
  }
}

/**
 * GET /api/app-ratings/:id
 */
async function getAppRatingByIdController(req, res) {
  try {
    const { id } = req.params;
    const row = await getAppRatingById(id);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "App rating not found.",
      });
    }

    return res.json({
      success: true,
      data: row,
    });
  } catch (err) {
    console.error("Error fetching app rating:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app rating.",
    });
  }
}

/**
 * PUT /api/app-ratings/:id
 * Body: { rating?, comment? }
 */
async function updateAppRatingController(req, res) {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body || {};

    const fields = {};
    if (rating != null) {
      const r = Number(rating);
      if (r < 1 || r > 5) {
        return res.status(400).json({
          success: false,
          message: "rating must be between 1 and 5",
        });
      }
      fields.rating = r;
    }
    if (comment != null) {
      fields.comment = comment;
    }

    const result = await updateAppRating(id, fields);

    if (!result || result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "App rating not found or nothing to update.",
      });
    }

    const updated = await getAppRatingById(id);

    return res.json({
      success: true,
      message: "App rating updated successfully.",
      data: updated,
    });
  } catch (err) {
    console.error("Error updating app rating:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to update app rating.",
    });
  }
}

/**
 * DELETE /api/app-ratings/:id
 * Body: {
 *   admin_user_id: number (required)  // admin's user_id
 * }
 * Verifies admin role (admin/super_admin) and logs into admin_logs directly.
 */
// DELETE /api/app-ratings/:id
async function deleteAppRatingController(req, res) {
  try {
    const { id } = req.params;
    const { admin_user_id } = req.body || {};

    // 1. Verify admin (super_admin or admin)
    const adminInfo = await verifyAdminOrSuperAdmin(admin_user_id);
    const { admin_user_id: adminId, admin_name, role } = adminInfo;

    // 2. Fetch rating before delete
    const existing = await getAppRatingById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "App rating not found.",
      });
    }

    // Extract comment safely
    const userComment = existing.comment
      ? existing.comment.trim()
      : "No comment";

    // 3. Delete rating
    const result = await deleteAppRating(id);
    if (!result || result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "App rating not found.",
      });
    }

    // 4. Insert admin log (direct SQL)
    try {
      const activity =
        `Admin ${admin_name} (id=${adminId}, role=${role}) ` +
        `deleted app rating #${id} ` +
        `(rating=${existing.rating}, comment="${userComment}", given_by_user=${existing.user_id})`;

      await db.query(
        `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`,
        [adminId, admin_name, activity]
      );
    } catch (logErr) {
      console.error("Error writing admin log for app rating delete:", logErr);
    }

    return res.json({
      success: true,
      message: "App rating deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting app rating:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to delete app rating.",
    });
  }
}

/**
 * GET /api/app-ratings/summary
 * Returns dashboard summary.
 */
async function getAppRatingSummaryController(req, res) {
  try {
    const summary = await getAppRatingSummary();
    return res.json({
      success: true,
      data: summary,
    });
  } catch (err) {
    console.error("Error fetching app rating summary:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app rating summary.",
    });
  }
}

module.exports = {
  createAppRatingController,
  listAppRatingsController,
  getAppRatingByIdController,
  updateAppRatingController,
  deleteAppRatingController,
  getAppRatingSummaryController,
};
