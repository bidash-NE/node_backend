const {
  createMartMenuRating,
  getMartMenuRatingSummary,
} = require("../models/martRatingsModel");

async function createRatingCtrl(req, res) {
  try {
    const out = await createMartMenuRating({
      menu_id: req.body.menu_id,
      user_id: req.body.user_id,
      rating: req.body.rating,
      comment: req.body.comment,
    });
    return res.status(201).json(out);
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to save rating." });
  }
}

async function getRatingSummaryCtrl(req, res) {
  try {
    const out = await getMartMenuRatingSummary(req.params.menu_id);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch rating summary.",
    });
  }
}

module.exports = { createRatingCtrl, getRatingSummaryCtrl };
