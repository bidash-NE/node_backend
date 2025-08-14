// routes/businessTypesRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/businessTypesController");

// Read
router.get("/business-types", ctrl.listBusinessTypes);
router.get("/business-types/:id", ctrl.getBusinessType);

// Special type filters
router.get("/business-types/type/food", ctrl.listFoodBusinessTypes);
router.get("/business-types/type/mart", ctrl.listMartBusinessTypes);

// Mutations
router.post("/business-types", ctrl.createBusinessType);
router.put("/business-types/:id", ctrl.updateBusinessType);
router.delete("/business-types/:id", ctrl.removeBusinessType);

module.exports = router;
