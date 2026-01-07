// controllers/martRatingsController.js
const {
  insertMartRating,
  fetchMartRatings,
} = require("../models/martRatingsModel");

exports.createMartRating = async (req, res) => {
  try {
    const { business_id, user_id, rating, comment } = req.body || {};

    const out = await insertMartRating({
      business_id,
      user_id,
      rating,
      comment,
    });

    return res.status(201).json(out);
  } catch (e) {
    const status = e.statusCode || 400;
    return res.status(status).json({
      success: false,
      message: e.message || "Failed to save feedback.",
    });
  }
};

exports.getMartRatings = async (req, res) => {
  try {
    const { business_id } = req.params;
    const { page, limit } = req.query;

    const out = await fetchMartRatings(business_id, { page, limit });
    return res.status(200).json(out);
  } catch (e) {
    const status = e.statusCode || 400;
    return res.status(status).json({
      success: false,
      message: e.message || "Failed to fetch feedback.",
    });
  }
};
