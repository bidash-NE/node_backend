// controllers/foodDiscoveryByBusinessTypeController.js
const { getFoodBusinessesByBusinessTypeId } = require("../models/foodDiscoveryModel");

// GET /api/food/business-types/:business_type_id/businesses
async function listFoodBusinessesByBusinessTypeIdCtrl(req, res) {
  try {
    const business_type_id = req.params.business_type_id;
    const out = await getFoodBusinessesByBusinessTypeId(business_type_id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("listFoodBusinessesByBusinessTypeIdCtrl:", e);
    return res
      .status(400)
      .json({ success: false, message: e.message || "Failed to fetch businesses." });
  }
}

module.exports = { listFoodBusinessesByBusinessTypeIdCtrl };
