// controllers/salesController.js
const { getTodaySalesForBusiness } = require("../models/salesModel");

/**
 * GET /api/sales/today/:business_id
 * For merchant dashboard:
 *  - sales for TODAY only
 *  - only COMPLETED orders
 *  - only items belonging to this business_id
 */
async function getTodaySales(req, res) {
  try {
    const business_id = Number(req.params.business_id);
    if (!Number.isFinite(business_id) || business_id <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid business_id" });
    }

    const stats = await getTodaySalesForBusiness(business_id);

    return res.status(200).json({
      success: true,
      message: "Today's sales fetched successfully.",
      data: stats,
    });
  } catch (err) {
    console.error("[getTodaySales ERROR]", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch today's sales.",
      error: err.message,
    });
  }
}

module.exports = {
  getTodaySales,
};
