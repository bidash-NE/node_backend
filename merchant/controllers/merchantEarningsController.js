// controllers/merchantEarningsController.js
const MerchantEarnings = require("../models/merchantEarningsModel");

function parseISODateOnly(s) {
  const v = String(s || "").trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v;
}

function clampGroupBy(v) {
  const g = String(v || "day")
    .trim()
    .toLowerCase();
  if (g === "day" || g === "week" || g === "month" || g === "year") return g;
  return "day";
}

// controllers/merchantEarningsController.js
// ✅ replace getMerchantEarningsByBusiness with this version (no range/group_by)

exports.getMerchantEarningsByBusiness = async (req, res) => {
  try {
    const business_id = Number(req.params.business_id);

    const data = await MerchantEarnings.getEarningsByBusiness(business_id);

    return res.json({
      success: true,
      business_id,
      summary: data.summary,
      rows: data.rows, // ✅ all earnings rows
    });
  } catch (err) {
    console.error("[getMerchantEarningsByBusiness]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};
