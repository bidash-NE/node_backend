// routes/martMenuBrowseRoute.js
const express = require("express");
const router = express.Router();

const {
  listMartMenuGroupedByCategoryCtrl,
} = require("../controllers/martMenuBrowseController");

// Example: GET http://localhost:9090/api/mart/businesses/101/menu-grouped
router.get(
  "/businesses/:business_id/menu-grouped",
  listMartMenuGroupedByCategoryCtrl
);

module.exports = router;
