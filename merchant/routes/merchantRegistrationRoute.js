// routes/merchantRegistrationRoutes.js
const express = require("express");
const router = express.Router();
const { upload } = require("../middlewares/upload");

const {
  registerMerchant,
  loginByUsername,
  updateMerchant,
  listFoodOwners,
  listMartOwners,
} = require("../controllers/merchantRegistrationController");

// Middleware to detect multipart/form-data
const maybeMulter = (req, res, next) => {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("multipart/form-data")) {
    return upload.fields([
      { name: "license_image", maxCount: 1 },
      { name: "business_logo", maxCount: 1 },
      { name: "bank_qr_code_image", maxCount: 1 },
    ])(req, res, next);
  }
  next();
};

// Register merchant
router.post("/register", maybeMulter, registerMerchant);

// Update business
router.put("/update/:businessId", maybeMulter, updateMerchant);

// Login by username
router.post("/login-username", loginByUsername);

// List business owners
router.get("/owners/food", listFoodOwners);
router.get("/owners/mart", listMartOwners);

module.exports = router;
