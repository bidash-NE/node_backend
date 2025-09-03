// controllers/martRatingsController.js
const {
  upsertMartMenuRating,
  fetchMartMenuRatings,
} = require("../models/martRatingsModel");

exports.createOrUpdateMartRating = async (req, res) => {
  try {
    const { menu_id, user_id, rating, comment } = req.body || {};
    const out = await upsertMartMenuRating({
      menu_id,
      user_id,
      rating,
      comment,
    });
    return res.status(201).json(out);
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to save rating." });
  }
};

exports.getMartRatings = async (req, res) => {
  try {
    const { menu_id } = req.params;
    const { page, limit } = req.query;
    const out = await fetchMartMenuRatings(menu_id, { page, limit });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch ratings.",
    });
  }
};
