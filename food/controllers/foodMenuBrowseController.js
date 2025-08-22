// controllers/foodMenuBrowseController.js
const { getFoodMenuGroupedByCategoryForBusiness } = require("../models/foodMenuBrowseModel");

// GET /api/food/businesses/:business_id/menu-grouped
async function listFoodMenuGroupedByCategoryCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await getFoodMenuGroupedByCategoryForBusiness(business_id);
    return res.status(200).json({
      success: true,
      message: "Menu grouped by category fetched successfully.",
      data: out.data,
      meta: out.meta,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to fetch grouped menu." });
  }
}

module.exports = { listFoodMenuGroupedByCategoryCtrl };
