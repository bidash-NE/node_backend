const {
  fetchBusinessRatingsAuto,
  likeFoodRating,
  unlikeFoodRating,
  likeMartRating,
  unlikeMartRating,
} = require("../models/merchantRatingsModel");

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
