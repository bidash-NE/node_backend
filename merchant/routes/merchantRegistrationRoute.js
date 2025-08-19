// routes/merchantRoute.js
const express = require("express");
const upload = require("../middlewares/upload");
const {
  registerMerchant,
  loginByUsername,
  updateMerchant,
} = require("../controllers/merchantRegistrationController");

const router = express.Router();

// If Content-Type is multipart/form-data -> use Multer; otherwise skip (JSON body)
const maybeMulter = (req, res, next) => {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("multipart/form-data")) {
    return upload.fields([
      { name: "license_image", maxCount: 1 },
      { name: "business_logo", maxCount: 1 },
      // The register route also uses these; update route ignores unknown fields
      { name: "bank_card_front_image", maxCount: 1 },
      { name: "bank_card_back_image", maxCount: 1 },
      { name: "bank_qr_code_image", maxCount: 1 },
    ])(req, res, next);
  }
  next();
};

router.post("/register", maybeMulter, registerMerchant);

/** Update business details (name, address, coords, logo, hours, holidays, types) */
router.put("/update/:businessId", maybeMulter, updateMerchant);

router.post("/login-username", loginByUsername);

module.exports = router;
