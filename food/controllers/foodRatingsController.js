// controllers/foodRatingsController.js
const {
  insertFoodRating,
  fetchFoodRatings,
} = require("../models/foodRatingsModel");

async function createFoodRating(req, res) {
  try {
    const { business_id, user_id, rating, comment } = req.body || {};

    const out = await insertFoodRating({
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
}

async function getFoodRatings(req, res) {
  try {
    const { business_id } = req.params;
    const { page, limit } = req.query;

    const out = await fetchFoodRatings(business_id, { page, limit });
    return res.status(200).json(out);
  } catch (e) {
    const status = e.statusCode || 400;
    return res.status(status).json({
      success: false,
      message: e.message || "Failed to fetch feedback.",
    });
  }
}

module.exports = { createFoodRating, getFoodRatings };
