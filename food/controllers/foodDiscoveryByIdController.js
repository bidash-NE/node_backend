// controllers/foodDiscoveryByBusinessTypeController.js
const {
  getFoodBusinessesByBusinessTypeId,
} = require("../models/foodDiscoveryModel");

// GET /api/food/discovery/business-types/businesses/:business_type_id
async function listFoodBusinessesByBusinessTypeIdCtrl(req, res) {
  try {
    const { business_type_id } = req.params;
    const out = await getFoodBusinessesByBusinessTypeId(business_type_id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    console.error("listFoodBusinessesByBusinessTypeIdCtrl:", e);
    const msg =
      e?.message ||
      "Failed to fetch businesses for the provided business_type_id.";
    const code = /positive integer|must be/i.test(msg) ? 400 : 500;
    return res.status(code).json({ success: false, message: msg });
  }
}

module.exports = { listFoodBusinessesByBusinessTypeIdCtrl };
