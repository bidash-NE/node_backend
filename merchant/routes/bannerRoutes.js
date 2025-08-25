// merchant/routes/bannerRoutes.js
const express = require("express");
const router = express.Router();

const {
  uploadBannerImage,
  createBannerCtrl,
  listBannersCtrl,
  getBannerCtrl,
  listActiveBannersByBusinessCtrl,
  updateBannerCtrl,
  deleteBannerCtrl,
} = require("../controllers/bannerController");

// Create (multipart or JSON base64; field: banner_image OR image)
router.post("/", uploadBannerImage(), createBannerCtrl);

// List (optionally ?business_id=&active_only=true)
router.get("/", listBannersCtrl);

// Active for a business (latest first)
router.get("/business/:business_id", listActiveBannersByBusinessCtrl);

// Single banner
router.get("/:id", getBannerCtrl);

// Update (supports image replacement / clearing)
router.put("/:id", uploadBannerImage(), updateBannerCtrl);

// Delete
router.delete("/:id", deleteBannerCtrl);

module.exports = router;
