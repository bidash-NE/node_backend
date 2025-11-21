// controllers/merchantRatingsController.js
const jwt = require("jsonwebtoken");

const {
  fetchBusinessRatingsAuto,
  likeFoodRating,
  unlikeFoodRating,
  likeMartRating,
  unlikeMartRating,
  createRatingReply,
  listRatingReplies,
  deleteRatingReply,
  deleteRatingWithReplies,
} = require("../models/merchantRatingsModel");

/* ---------- existing ratings / likes ---------- */

exports.getBusinessRatingsAutoCtrl = async (req, res) => {
  try {
    const { business_id } = req.params;
    const { page, limit } = req.query;

    const out = await fetchBusinessRatingsAuto(Number(business_id), {
      page,
      limit,
    });

    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch merchant ratings.",
    });
  }
};

/* ---------- FOOD like / unlike ---------- */

exports.likeFoodRatingCtrl = async (req, res) => {
  try {
    const { rating_id } = req.params;
    const out = await likeFoodRating(Number(rating_id));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to like food rating.",
    });
  }
};

exports.unlikeFoodRatingCtrl = async (req, res) => {
  try {
    const { rating_id } = req.params;
    const out = await unlikeFoodRating(Number(rating_id));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to unlike food rating.",
    });
  }
};

/* ---------- MART like / unlike ---------- */

exports.likeMartRatingCtrl = async (req, res) => {
  try {
    const { rating_id } = req.params;
    const out = await likeMartRating(Number(rating_id));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to like mart rating.",
    });
  }
};

exports.unlikeMartRatingCtrl = async (req, res) => {
  try {
    const { rating_id } = req.params;
    const out = await unlikeMartRating(Number(rating_id));
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to unlike mart rating.",
    });
  }
};

/* ---------- NEW: replies (Redis-backed) ---------- */

/**
 * POST /api/merchant/ratings/:type/:rating_id/replies
 * Body: { text }
 */
exports.createRatingReplyCtrl = async (req, res) => {
  try {
    const { type, rating_id } = req.params;
    const user_id = req.user?.user_id;
    const text = String(req.body?.text || "").trim();

    if (!user_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!text || text.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Reply text is required",
      });
    }
    if (text.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Reply text is too long (max 1000 chars)",
      });
    }

    const out = await createRatingReply({
      rating_type: type,
      rating_id: Number(rating_id),
      user_id: Number(user_id),
      text,
    });

    return res.status(201).json(out);
  } catch (e) {
    console.error("[createRatingReplyCtrl]", e?.message || e);
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to create reply.",
    });
  }
};

/**
 * GET /api/merchant/ratings/:type/:rating_id/replies?page=&limit=
 */
exports.listRatingRepliesCtrl = async (req, res) => {
  try {
    const { type, rating_id } = req.params;
    const { page, limit } = req.query;

    const out = await listRatingReplies({
      rating_type: type,
      rating_id: Number(rating_id),
      page,
      limit,
    });

    return res.status(200).json(out);
  } catch (e) {
    console.error("[listRatingRepliesCtrl]", e?.message || e);
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to list replies.",
    });
  }
};

/**
 * DELETE /api/merchant/ratings/replies/:reply_id
 * Only creator can delete.
 */
exports.deleteRatingReplyCtrl = async (req, res) => {
  try {
    const { reply_id } = req.params;
    const user_id = req.user?.user_id;

    if (!user_id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const out = await deleteRatingReply({
      reply_id: Number(reply_id),
      user_id: Number(user_id),
    });

    return res.status(200).json(out);
  } catch (e) {
    console.error("[deleteRatingReplyCtrl]", e?.message || e);

    if (e && e.code === "FORBIDDEN") {
      return res
        .status(403)
        .json({ success: false, message: e.message || "Not allowed" });
    }

    if (e && e.code === "NOT_FOUND") {
      return res
        .status(404)
        .json({ success: false, message: e.message || "Not found" });
    }

    return res.status(400).json({
      success: false,
      message: e.message || "Failed to delete reply.",
    });
  }
};

/**
 * DELETE /api/merchant/ratings/:type/:rating_id
 * Deletes the rating (comment) AND all its replies.
 */
// helper: decode user_id directly from access token
function getUserIdFromAccessToken(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  if (!token) {
    const err = new Error("Missing access token");
    err.code = "UNAUTHORIZED";
    throw err;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const uid = Number(decoded?.user_id);

    if (!Number.isFinite(uid) || uid <= 0) {
      const err = new Error("Invalid token payload: user_id missing");
      err.code = "UNAUTHORIZED";
      throw err;
    }

    return uid;
  } catch (e) {
    const err = new Error("Invalid or expired access token");
    err.code = "UNAUTHORIZED";
    throw err;
  }
}

exports.deleteRatingWithRepliesCtrl = async (req, res) => {
  try {
    const { type, rating_id } = req.params;

    const user_id = getUserIdFromAccessToken(req); // ✅ decode here

    const out = await deleteRatingWithReplies({
      rating_type: type,
      rating_id: Number(rating_id),
      user_id,
    });

    return res.status(200).json(out);
  } catch (e) {
    console.error("[deleteRatingWithRepliesCtrl]", e?.message || e);

    if (e?.code === "UNAUTHORIZED") {
      return res
        .status(401)
        .json({ success: false, message: e.message || "Unauthorized" });
    }

    if (e?.code === "NOT_FOUND") {
      return res
        .status(404)
        .json({ success: false, message: e.message || "Rating not found" });
    }

    if (e?.code === "FORBIDDEN") {
      return res
        .status(403)
        .json({ success: false, message: e.message || "Forbidden" });
    }

    return res.status(400).json({
      success: false,
      message: e.message || "Failed to delete rating.",
    });
  }
};
