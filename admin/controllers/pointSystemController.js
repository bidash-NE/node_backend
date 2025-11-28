// controllers/pointSystemController.js
const pointSystemModel = require("../models/pointSystemModel");

// GET /point-system?onlyActive=true
exports.getAllPointRules = async (req, res) => {
  try {
    const onlyActive =
      String(req.query.onlyActive || "").toLowerCase() === "true";
    const rules = await pointSystemModel.getAllPointRules(onlyActive);

    return res.status(200).json({
      success: true,
      count: rules.length,
      data: rules,
    });
  } catch (err) {
    console.error("Error fetching point rules:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// GET /point-system/:id
exports.getPointRuleById = async (req, res) => {
  try {
    const { id } = req.params;

    const rule = await pointSystemModel.getPointRuleById(id);
    if (!rule) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    return res.status(200).json({
      success: true,
      data: rule,
    });
  } catch (err) {
    console.error("Error fetching point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// POST /point-system
// body: { min_amount_per_point, point_to_award, is_active? }
exports.createPointRule = async (req, res) => {
  try {
    const { min_amount_per_point, point_to_award, is_active } = req.body || {};

    // Basic validation
    if (min_amount_per_point === undefined || point_to_award === undefined) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point and point_to_award are required.",
      });
    }

    const minAmountNum = Number(min_amount_per_point);
    const pointsNum = Number(point_to_award);

    if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point must be a positive number.",
      });
    }

    if (!Number.isInteger(pointsNum) || pointsNum < 0) {
      return res.status(400).json({
        success: false,
        error: "point_to_award must be a non-negative integer.",
      });
    }

    const rule = await pointSystemModel.createPointRule({
      min_amount_per_point: minAmountNum,
      point_to_award: pointsNum,
      is_active: is_active !== undefined ? !!is_active : true,
    });

    return res.status(201).json({
      success: true,
      message: "Point rule created successfully.",
      data: rule,
    });
  } catch (err) {
    console.error("Error creating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// PUT /point-system/:id
// body: { min_amount_per_point?, point_to_award?, is_active? }
exports.updatePointRule = async (req, res) => {
  try {
    const { id } = req.params;
    let { min_amount_per_point, point_to_award, is_active } = req.body || {};

    const updates = {};

    if (min_amount_per_point !== undefined) {
      const minAmountNum = Number(min_amount_per_point);
      if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
        return res.status(400).json({
          success: false,
          error: "min_amount_per_point must be a positive number.",
        });
      }
      updates.min_amount_per_point = minAmountNum;
    }

    if (point_to_award !== undefined) {
      const pointsNum = Number(point_to_award);
      if (!Number.isInteger(pointsNum) || pointsNum < 0) {
        return res.status(400).json({
          success: false,
          error: "point_to_award must be a non-negative integer.",
        });
      }
      updates.point_to_award = pointsNum;
    }

    if (is_active !== undefined) {
      updates.is_active = !!is_active;
    }

    const updated = await pointSystemModel.updatePointRule(id, updates);

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    return res.status(200).json({
      success: true,
      message: "Point rule updated successfully.",
      data: updated,
    });
  } catch (err) {
    console.error("Error updating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// DELETE /point-system/:id
exports.deletePointRule = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await pointSystemModel.deletePointRule(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    return res.status(200).json({
      success: true,
      message: "Point rule deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};
