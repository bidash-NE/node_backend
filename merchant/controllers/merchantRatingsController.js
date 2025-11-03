const { fetchBusinessRatingsAuto } = require("../models/merchantRatingsModel");

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
