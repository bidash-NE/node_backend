// routes/merchantRegistrationRoutes.js
const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");

const {
  registerMerchant,
  loginByUsername,
  updateMerchant,
  listFoodOwners,
  listMartOwners,
} = require("../controllers/merchantRegistrationController");

// If Content-Type is multipart/form-data -> use Multer; otherwise skip (JSON body)
const maybeMulter = (req, res, next) => {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("multipart/form-data")) {
    return upload.fields([
      { name: "license_image", maxCount: 1 },
      { name: "business_logo", maxCount: 1 },
      { name: "bank_qr_code_image", maxCount: 1 }, // kept
    ])(req, res, next);
  }
  next();
};

// Register
router.post("/register", maybeMulter, registerMerchant);

// Update business (partial)
router.put("/update/:businessId", maybeMulter, updateMerchant);

// Login
router.post("/login-username", loginByUsername);

// NEW: owners by kind
router.get("/owners/food", listFoodOwners);
router.get("/owners/mart", listMartOwners);

module.exports = router;
