// routes/martMenuRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/martMenuController");
const { uploadMartMenuImage } = require("../middlewares/uploadMartMenuImage");

// Create (multipart supported)
// field name: item_image
router.post("/", uploadMartMenuImage, ctrl.createMartMenu);

// List with filters
router.get("/", ctrl.listMartMenu);

// List by business
router.get("/business/:business_id", ctrl.listMartMenuByBusiness);

// Get one
router.get("/:id", ctrl.getMartMenuItem);

// Update (multipart supported)
router.put("/:id", uploadMartMenuImage, ctrl.updateMartMenu);

// Delete
router.delete("/:id", ctrl.deleteMartMenu);

module.exports = router;
