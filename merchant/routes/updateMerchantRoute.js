const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");
const {
  updateMerchantBusiness,
  getMerchantBusiness,
} = require("../controllers/updateMerchantController");

// Use upload.single for business_logo field
router.put(
  "/merchant-business/:business_id",
  upload.single("business_logo"),
  updateMerchantBusiness
);

router.get("/merchant-business/:business_id", getMerchantBusiness);

module.exports = router;
