// controllers/appRatingController.js  ✅ FULL (ADMIN SIDE)
const db = require("../config/db");
const {
  createAppRating,
  getAppRatingById,
  listAppRatings,
  updateAppRating,
  deleteAppRating,
  getAppRatingSummary,

  // ✅ REPORTS (Redis + DB)
  listMerchantReports,
  ignoreMerchantReport,
  deleteReportedMerchantCommentByReport,
  deleteReportedMerchantReplyByReport,
} = require("../models/appRatingModel");

/* ---------------- helpers ---------------- */

async function verifyAdminOrSuperAdminFromToken(req) {
  const admin_user_id = Number(req.user?.user_id);
  if (!admin_user_id || Number.isNaN(admin_user_id)) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  // role from token (fast path)
  const tokenRole = String(req.user?.role || "").toLowerCase();
  const allowed = new Set(["admin", "super admin", "superadmin"]);

  // If token has role and it's allowed, accept.
  if (allowed.has(tokenRole)) {
    return {
      admin_user_id,
      admin_name: req.user?.user_name || "ADMIN",
      role: tokenRole,
    };
  }

  // Otherwise, confirm from DB
  const [rows] = await db.query(
    "SELECT user_id, user_name, role FROM users WHERE user_id = ? LIMIT 1",
    [admin_user_id]
  );
  if (!rows.length) {
    const err = new Error("Admin user not found");
    err.statusCode = 404;
    throw err;
  }

  const admin = rows[0];
  const role = String(admin.role || "").toLowerCase();
  if (!allowed.has(role)) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }

  return {
    admin_user_id: admin.user_id,
    admin_name: admin.user_name || "ADMIN",
    role,
  };
}

/* ---------------- existing app rating controllers ---------------- */

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

    let role = null;
    const [[userRow]] = await db.query(
      "SELECT role FROM users WHERE user_id = ? LIMIT 1",
      [user_id]
    );
    if (userRow && userRow.role) role = userRow.role;

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
      meta: { page: pageNum, pageSize: sizeNum },
    });
  } catch (err) {
    console.error("Error listing app ratings:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app ratings.",
    });
  }
}

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

    return res.json({ success: true, data: row });
  } catch (err) {
    console.error("Error fetching app rating:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app rating.",
    });
  }
}

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
    if (comment != null) fields.comment = comment;

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

async function deleteAppRatingController(req, res) {
  try {
    const admin = await verifyAdminOrSuperAdminFromToken(req);

    const { id } = req.params;
    const existing = await getAppRatingById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "App rating not found.",
      });
    }

    const userComment = existing.comment
      ? existing.comment.trim()
      : "No comment";

    const result = await deleteAppRating(id);
    if (!result || result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "App rating not found.",
      });
    }

    try {
      const activity =
        `Admin ${admin.admin_name} (id=${admin.admin_user_id}, role=${admin.role}) ` +
        `deleted app rating #${id} ` +
        `(rating=${existing.rating}, comment="${userComment}", given_by_user=${existing.user_id})`;

      await db.query(
        `INSERT INTO admin_logs (user_id, admin_name, activity) VALUES (?, ?, ?)`,
        [admin.admin_user_id, admin.admin_name, activity]
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

async function getAppRatingSummaryController(req, res) {
  try {
    const summary = await getAppRatingSummary();
    return res.json({ success: true, data: summary });
  } catch (err) {
    console.error("Error fetching app rating summary:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch app rating summary.",
    });
  }
}

/* ---------------- ✅ NEW: ADMIN REPORTS API ---------------- */

/**
 * GET /api/app-ratings/reports/comments?type=food|mart&page&limit
 */
async function listReportedCommentsController(req, res) {
  try {
    await verifyAdminOrSuperAdminFromToken(req);

    const { type = "food", page = "1", limit = "20" } = req.query;

    const out = await listMerchantReports({
      type,
      target: "comment",
      page: Number(page),
      limit: Number(limit),
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error("listReportedCommentsController error:", err);
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to list reported comments",
    });
  }
}

/**
 * GET /api/app-ratings/reports/replies?type=food|mart&page&limit
 */
async function listReportedRepliesController(req, res) {
  try {
    await verifyAdminOrSuperAdminFromToken(req);

    const { type = "food", page = "1", limit = "20" } = req.query;

    const out = await listMerchantReports({
      type,
      target: "reply",
      page: Number(page),
      limit: Number(limit),
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error("listReportedRepliesController error:", err);
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to list reported replies",
    });
  }
}

/**
 * POST /api/app-ratings/reports/:report_id/ignore
 */
async function ignoreReportController(req, res) {
  try {
    const admin = await verifyAdminOrSuperAdminFromToken(req);
    const report_id = Number(req.params.report_id);

    const out = await ignoreMerchantReport({ report_id, admin });
    return res.status(200).json(out);
  } catch (err) {
    console.error("ignoreReportController error:", err);
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to ignore report",
    });
  }
}

/**
 * DELETE /api/app-ratings/reports/:report_id/comment
 */
async function deleteReportedCommentController(req, res) {
  try {
    const admin = await verifyAdminOrSuperAdminFromToken(req);
    const report_id = Number(req.params.report_id);

    const out = await deleteReportedMerchantCommentByReport({
      report_id,
      admin,
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error("deleteReportedCommentController error:", err);
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to delete reported comment",
    });
  }
}

/**
 * DELETE /api/app-ratings/reports/:report_id/reply
 */
async function deleteReportedReplyController(req, res) {
  try {
    const admin = await verifyAdminOrSuperAdminFromToken(req);
    const report_id = Number(req.params.report_id);

    const out = await deleteReportedMerchantReplyByReport({
      report_id,
      admin,
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error("deleteReportedReplyController error:", err);
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message || "Failed to delete reported reply",
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

  // ✅ NEW
  listReportedCommentsController,
  listReportedRepliesController,
  ignoreReportController,
  deleteReportedCommentController,
  deleteReportedReplyController,
};
