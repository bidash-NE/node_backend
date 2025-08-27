const express = require("express");
const router = express.Router();

const {
  listMartMenuGroupedByCategoryCtrl,
} = require("../controllers/martMenuBrowseController");

// GET /api/mart/browse/businesses/:business_id/menu-grouped
router.get(
  "/businesses/:business_id/menu-grouped",
  listMartMenuGroupedByCategoryCtrl
);

module.exports = router;
