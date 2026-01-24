// controllers/updateMerchantController.js
const fs = require("fs");
const path = require("path");
const {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
} = require("../models/updateMerchantModel");

function safeUnlink(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (e) {
    console.error("Failed to delete file:", absPath, e?.message || e);
  }
}

function absFromStored(storedPath) {
  if (!storedPath) return null;

  // If storedPath is like "/uploads/logos/xxx.jpg", convert to disk path:
  // UPLOAD_ROOT/logos/xxx.jpg
  const cleaned = String(storedPath).replace(/\\/g, "/");

  // If you store raw multer disk path like "uploads/logos/xxx.jpg"
  // path.join(process.cwd(), ...) works too.
  // We'll support both formats:
  if (cleaned.startsWith("/uploads/")) {
    return path.join(process.cwd(), cleaned.replace("/uploads/", "uploads/"));
  }

  return path.isAbsolute(cleaned) ? cleaned : path.join(process.cwd(), cleaned);
}

function toStoredPath(filePath) {
  // multer gives disk path; normalize slashes
  return String(filePath || "").replace(/\\/g, "/");
}

async function updateMerchantBusiness(req, res) {
  const business_id = Number(req.params.business_id);
  const updateFields = { ...req.body };

  try {
    const currentBusiness = await getMerchantBusinessDetailsById(business_id);
    if (!currentBusiness) {
      return res
        .status(404)
        .json({ success: false, message: "Merchant business not found." });
    }

    // ✅ with upload.fields(), files are in req.files[fieldname][0]
    const newBusinessLogo = req.files?.business_logo?.[0];
    const newLicenseImage = req.files?.license_image?.[0];

    if (newBusinessLogo) {
      // delete old
      safeUnlink(absFromStored(currentBusiness.business_logo));
      // set new
      updateFields.business_logo = toStoredPath(newBusinessLogo.path);
    }

    if (newLicenseImage) {
      // delete old
      safeUnlink(absFromStored(currentBusiness.license_image));
      // set new
      updateFields.license_image = toStoredPath(newLicenseImage.path);
    }

    // Special celebration validation (your existing logic)
    if (updateFields.special_celebration !== undefined) {
      updateFields.special_celebration =
        updateFields.special_celebration || null;

      if (
        updateFields.special_celebration &&
        updateFields.special_celebration_discount_percentage === undefined
      ) {
        return res.status(400).json({
          success: false,
          message:
            "special_celebration_discount_percentage is required when special_celebration is provided.",
        });
      }
    }

    const updated = await updateMerchantBusinessDetails(
      business_id,
      updateFields,
    );

    if (!updated) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Merchant business details updated successfully.",
    });
  } catch (err) {
    console.error("[updateMerchantBusiness] error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Update failed.",
    });
  }
}

module.exports = {
  updateMerchantBusiness,
};
