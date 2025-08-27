const {
  getMartBusinessesByBusinessTypeId,
} = require("../models/martDiscoveryByIdModel");

async function listMartBusinessesByBusinessTypeIdCtrl(req, res) {
  try {
    const { business_type_id } = req.params;
    const out = await getMartBusinessesByBusinessTypeId(business_type_id);
    return res.status(out.success ? 200 : 404).json(out);
  } catch (e) {
    const msg = e?.message || "Failed to fetch MART businesses.";
    const code = /positive integer|must be/i.test(msg) ? 400 : 500;
    return res.status(code).json({ success: false, message: msg });
  }
}

module.exports = { listMartBusinessesByBusinessTypeIdCtrl };
