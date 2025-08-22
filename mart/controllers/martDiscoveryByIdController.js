// controllers/martDiscoveryByIdController.js
const {
  getMartBusinessesByBusinessTypeId,
} = require("../models/martDiscoveryByIdModel");

exports.getBusinessesByBusinessTypeId = async (req, res) => {
  try {
    const out = await getMartBusinessesByBusinessTypeId(
      req.params.business_type_id
    );
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    return res.status(400).json({
      success: false,
      message: e.message || "Unable to fetch mart businesses",
    });
  }
};
