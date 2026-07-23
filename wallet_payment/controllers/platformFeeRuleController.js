const PlatformFeeRule = require("../models/platformFeeRuleModel");

exports.getFeePercentage = async (req, res) => {
  try {
    const rule = await PlatformFeeRule.getFeePercentBp();

    if (!rule) {
      return res.status(404).json({
        success: false,
        message: "No platform fee rule found",
      });
    }

    // Convert basis points → integer percentage
    const percentage = Math.round(Number(rule.fee_percent_bp || 0) / 100);

    res.status(200).json({
      success: true,
      fee_percent_bp: rule.fee_percent_bp,
      fee_percent: percentage,
    });
  } catch (err) {
    console.error("Error fetching platform fee:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

exports.getBannerFee = async (_req, res) => {
  try {
    const rule = await PlatformFeeRule.getBannerFeeRule();

    if (!rule) {
      return res.status(404).json({
        success: false,
        message: "No banner fee rule found",
      });
    }

    const feeCents = Number(rule.fee_fixed_cents || 0);
    const feeNu = Number((feeCents / 100).toFixed(2));

    return res.status(200).json({
      success: true,
      data: {
        rule_id: rule.rule_id,
        service_type: rule.service_type,
        fee_type: rule.fee_type,
        fee_fixed_cents: feeCents,
        fee_nu: feeNu,
        currency: "BTN",
        apply_on: rule.apply_on,
        starts_at: rule.starts_at,
        ends_at: rule.ends_at,
      },
    });
  } catch (err) {
    console.error("Error fetching banner fee:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};
