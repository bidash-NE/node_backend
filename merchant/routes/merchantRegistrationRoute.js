const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");
const rateLimit = require("express-rate-limit");
const {
  registerMerchant,
  loginByEmail,
  updateMerchant,
  listFoodOwners,
  listMartOwners,
  listFoodOwnersWithCelebration,
  listMartOwnersWithCelebration,
} = require("../controllers/merchantRegistrationController");

// TEMP LOAD-TEST BYPASS (2026-06-22): default raised to effectively
// unlimited for 1000-user capacity testing. REVERT to 7 before any
// production deploy.
let rateLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: Number(process.env.MERCHANT_AUTH_RATE_LIMIT_MAX || 1000000),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      message:
        "Too many requests from this IP, please try again after 2 minutes.",
    });
  },
});

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
router.post("/register", rateLimiter, maybeMulter, registerMerchant);

// Update business
// router.put("/update/:businessId", maybeMulter, updateMerchant);

// Login by username
router.post("/login-email", rateLimiter, loginByEmail);

// List business owners
router.get("/owners/food", listFoodOwners);
router.get("/owners/mart", listMartOwners);

// List food businesses with special celebrations
router.get("/owners/food/celebration", listFoodOwnersWithCelebration);

// List mart businesses with special celebrations
router.get("/owners/mart/celebration", listMartOwnersWithCelebration);

module.exports = router;
