const db = require("../config/db");

// Fetch the single fee_percent_bp value
async function getFeePercentBp() {
  const [rows] = await db.query(
    "SELECT fee_percent_bp FROM platform_fee_rules LIMIT 1"
  );
  return rows[0] || null;
}

module.exports = { getFeePercentBp };
