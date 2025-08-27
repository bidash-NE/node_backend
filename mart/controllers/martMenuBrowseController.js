const {
  getMartMenuGroupedByCategoryForBusiness,
} = require("../models/martMenuBrowseModel");

async function listMartMenuGroupedByCategoryCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await getMartMenuGroupedByCategoryForBusiness(business_id);
    return res.status(200).json({
      success: true,
      message: "Mart menu grouped by category fetched successfully.",
      data: out.data,
      meta: out.meta,
    });
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Failed to fetch grouped mart menu.",
    });
  }
}

module.exports = { listMartMenuGroupedByCategoryCtrl };
