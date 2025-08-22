// controllers/martMenuBrowseController.js
const {
  getMartMenuGroupedByCategoryForBusiness,
} = require("../models/martMenuBrowseModel");

exports.getMartMenuGrouped = async (req, res) => {
  try {
    const business_id = req.params.business_id || req.query.business_id;
    const out = await getMartMenuGroupedByCategoryForBusiness(business_id);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Unable to fetch mart menu grouped",
    });
  }
};
