// controllers/martMenuBrowseController.js
const {
  getMartMenuGroupedByCategoryForBusiness,
} = require("../models/martMenuBrowseModel");

// GET /api/mart/businesses/:business_id/menu-grouped
async function listMartMenuGroupedByCategoryCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await getMartMenuGroupedByCategoryForBusiness(business_id);
    return res.status(200).json({
      success: true,
      message: "Menu grouped by category fetched successfully.",
      data: out.data,
      meta: out.meta, // now includes min_amount_for_fd
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch grouped menu.",
    });
  }
}

module.exports = { listMartMenuGroupedByCategoryCtrl };
