const express = require("express");
const router = express.Router();

const {
  listMartBusinessesByBusinessTypeIdCtrl,
} = require("../controllers/martDiscoveryByIdController");

// GET /api/mart/discovery/business-types/businesses/:business_type_id
router.get(
  "/business-types/businesses/:business_type_id",
  listMartBusinessesByBusinessTypeIdCtrl
);

module.exports = router;
