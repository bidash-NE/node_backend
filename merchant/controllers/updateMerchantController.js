const fs = require("fs");
const path = require("path");
const {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
} = require("../models/updateMerchantModel");

async function updateMerchantBusiness(req, res) {
  const business_id = req.params.business_id;
  const updateFields = req.body;

  // If a file was uploaded, set business_logo to its path
  if (req.file) {
    // Get current business details to find previous image
    const currentBusiness = await getMerchantBusinessDetailsById(business_id);
    if (currentBusiness && currentBusiness.business_logo) {
      const oldImagePath = path.resolve(currentBusiness.business_logo);
      // Only delete if file exists and is not the same as the new file
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
    // Ensure the special_celebration field is handled
    if (updateFields.special_celebration !== undefined) {
      updateFields.special_celebration =
        updateFields.special_celebration || null;
    }

    const updated = await updateMerchantBusinessDetails(
      business_id,
      updateFields
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
    if (business) {
      return res.status(200).json(business);
    } else {
      return res.status(404).json({ error: "Merchant business not found." });
    }
  } catch (err) {
    return res
      .status(500)
      .json({ error: err.message || "Failed to fetch business details." });
  }
}

module.exports = {
  updateMerchantBusiness,
  getMerchantBusiness,
};
