// controllers/updateMerchantController.js
const fs = require("fs");
const path = require("path");
const {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
  clearSpecialCelebrationByBusinessId,
} = require("../models/updateMerchantModel");

async function updateMerchantBusiness(req, res) {
  const business_id = req.params.business_id;
  const updateFields = req.body;

  if (req.file) {
    const currentBusiness = await getMerchantBusinessDetailsById(business_id);
    if (currentBusiness && currentBusiness.business_logo) {
      const oldImagePath = path.resolve(currentBusiness.business_logo);
      if (
        fs.existsSync(oldImagePath) &&
        oldImagePath !== path.resolve(req.file.path)
      ) {
        fs.unlink(oldImagePath, (err) => {
          if (err) console.error("Failed to delete old business_logo:", err);
        });
      }
    }
    updateFields.business_logo = req.file.path.replace(/\\/g, "/");
  }

  try {
    if (updateFields.special_celebration !== undefined) {
      updateFields.special_celebration =
        updateFields.special_celebration || null;

      if (
        updateFields.special_celebration &&
        updateFields.special_celebration_discount_percentage === undefined
      ) {
        return res.status(400).json({
          error:
            "special_celebration_discount_percentage is required when special_celebration is provided.",
        });
      }
    }

    const updated = await updateMerchantBusinessDetails(
      business_id,
      updateFields,
    );

    if (updated) {
      return res
        .status(200)
        .json({ message: "Merchant business details updated successfully." });
    } else {
      return res.status(404).json({
        error: "Merchant business not found or no valid fields provided.",
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || "Update failed." });
  }
}

async function getMerchantBusiness(req, res) {
  const business_id = req.params.business_id;
  try {
    const business = await getMerchantBusinessDetailsById(business_id);
    if (business) return res.status(200).json(business);
    return res.status(404).json({ error: "Merchant business not found." });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to fetch business details." });
  }
}

/**
 * ✅ DELETE special celebration
 * Route: DELETE /merchant-business/:business_id/special-celebration
 * Auth: Bearer token via authUser (req.user populated)
 */
async function removeSpecialCelebration(req, res) {
  const business_id = Number(req.params.business_id);

  try {
    const business = await getMerchantBusinessDetailsById(business_id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }

    // OPTIONAL: enforce ownership if your table has user_id/merchant_id column
    // If you have a column like business.user_id, uncomment and adapt:
    //
    // if (business.user_id && Number(business.user_id) !== Number(req.user.user_id)) {
    //   return res.status(403).json({ success: false, message: "Forbidden" });
    // }

    // Idempotent: if already null, return success
    if (
      business.special_celebration == null &&
      business.special_celebration_discount_percentage == null
    ) {
      return res.status(200).json({
        success: true,
        message: "Special celebration already removed.",
      });
    }

    await clearSpecialCelebrationByBusinessId(business_id);

    return res.status(200).json({
      success: true,
      message: "Special celebration removed successfully.",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to remove special celebration.",
    });
  }
}

module.exports = {
  updateMerchantBusiness,
  getMerchantBusiness,
  removeSpecialCelebration,
};
