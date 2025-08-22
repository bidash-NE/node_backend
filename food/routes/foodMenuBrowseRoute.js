// routes/foodMenuBrowseRoute.js
const express = require("express");
const router = express.Router();

const {
  listFoodMenuGroupedByCategoryCtrl,
} = require("../controllers/foodMenuBrowseController");

// Example: GET http://localhost:9090/api/food/businesses/101/menu-grouped
router.get("/businesses/:business_id/menu-grouped", listFoodMenuGroupedByCategoryCtrl);

module.exports = router;
