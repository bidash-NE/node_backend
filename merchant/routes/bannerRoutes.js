const express = require("express");
const router = express.Router();

const {
  uploadBannerImage,
  createBannerCtrl,
  listBannersCtrl,
  getBannerCtrl,
  listAllBannersByBusinessCtrl, // <-- use ALL banners controller here
  listActiveFoodCtrl,
  listActiveMartCtrl,
  updateBannerCtrl,
  deleteBannerCtrl,
} = require("../controllers/bannerController");

/* validators */
const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

/* ---------------- routes ---------------- */

// Create (multipart or JSON base64; field: banner_image OR image)
router.post("/", uploadBannerImage(), createBannerCtrl);

/**
 * Kinded ACTIVE endpoints:
 *  - GET /api/banners/food?business_id=(optional)
 *  - GET /api/banners/mart?business_id=(optional)
 */
router.get("/food", listActiveFoodCtrl);
router.get("/mart", listActiveMartCtrl);

/**
 * By business: fetch ALL banners (active + inactive), optional ?owner_type=food|mart
 */
router.get(
  "/business/:business_id",
  validateBusinessIdParam,
  listAllBannersByBusinessCtrl
);

/**
 * Generic list (admin/debug) — supports ?business_id=&active_only=1&owner_type=food|mart
 */
router.get("/", listBannersCtrl);

// Single banner (no active filter)
router.get("/:id", validateIdParam, getBannerCtrl);

// Update (supports image replacement / clearing)
router.put("/:id", validateIdParam, uploadBannerImage(), updateBannerCtrl);

// Delete
router.delete("/:id", validateIdParam, deleteBannerCtrl);

module.exports = router;
