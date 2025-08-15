// routes/businessTypesRoutes.js
const express = require("express");
const router = express.Router();

const {
  listBusinessTypes,
  getBusinessType,
  listFoodBusinessTypes,
  listMartBusinessTypes,
  createBusinessType,
  updateBusinessType,
  removeBusinessType,
} = require("../controllers/businessTypesController");

const {
  uploadBusinessTypeImage,
} = require("../middlewares/businessTypesImage");

// list/get
router.get("/business-types", listBusinessTypes);
router.get("/business-types/:id", getBusinessType);
router.get("/business-types/type/food", listFoodBusinessTypes);
router.get("/business-types/type/mart", listMartBusinessTypes);

// create/update with image upload (field name: "image")
router.post("/business-types", uploadBusinessTypeImage, createBusinessType);
router.put("/business-types/:id", uploadBusinessTypeImage, updateBusinessType);

// delete
router.delete("/business-types/:id", removeBusinessType);

module.exports = router;
