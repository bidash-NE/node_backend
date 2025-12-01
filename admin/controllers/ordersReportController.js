// controllers/ordersReportController.js
const Reports = require("../models/ordersReportModel");

function parseQuery(req) {
  const {
    business_id,
    business_ids, // e.g., "26,27,31"
    user_id,
    status,
    date_from, // YYYY-MM-DD
    date_to, // YYYY-MM-DD
    limit,
    offset,
  } = req.query;

  let businessIdList = [];
  if (business_ids) {
    businessIdList = String(business_ids)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  if (business_id && Number.isFinite(Number(business_id))) {
    businessIdList.push(Number(business_id));
  }
  businessIdList = [...new Set(businessIdList)];

  return {
    businessIds: businessIdList,
    userId: user_id ? Number(user_id) : undefined,
    status: status ? String(status).toUpperCase() : undefined,
    dateFrom: date_from || undefined,
    dateTo: date_to || undefined,
    limit: limit ? Math.min(Math.max(Number(limit), 1), 500) : 100,
    offset: offset ? Math.max(Number(offset), 0) : 0,
  };
}

/* ---------------- existing ORDER reports ---------------- */

exports.getFoodOrdersReport = async (req, res) => {
  try {
    const args = parseQuery(req);
    const rows = await Reports.fetchOrdersReportByOwnerType({
      ...args,
      ownerType: "food",
    });
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getFoodOrdersReport] Error:", err);
    res.status(500).json({ error: "Failed to fetch food orders report" });
  }
};

exports.getMartOrdersReport = async (req, res) => {
  try {
    const args = parseQuery(req);
    const rows = await Reports.fetchOrdersReportByOwnerType({
      ...args,
      ownerType: "mart",
    });
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getMartOrdersReport] Error:", err);
    res.status(500).json({ error: "Failed to fetch mart orders report" });
  }
};

/* ---------------- new FOOD + MART REVENUE report ---------------- */

exports.getFoodMartRevenueReport = async (req, res) => {
  try {
    const args = parseQuery(req);
    const rows = await Reports.fetchFoodMartRevenueReport(args);
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getFoodMartRevenueReport] Error:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch food & mart revenue report" });
  }
};
