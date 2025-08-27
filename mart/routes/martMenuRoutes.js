const express = require("express");
const router = express.Router();

const { uploadMartMenuImage } = require("../middlewares/uploadMartMenuImage");
const ctrl = require("../controllers/martMenuController");

// CREATE (multipart supported)
router.post("/", uploadMartMenuImage(), ctrl.createMartMenu);

// LIST (filters ?business_id=&category_name=)
router.get("/", ctrl.listMartMenu);

// BY BUSINESS
router.get("/business/:business_id", ctrl.listMartMenuByBusiness);

// GET ONE
router.get("/:id", ctrl.getMartMenuItem);

// UPDATE (multipart supported)
router.put("/:id", uploadMartMenuImage(), ctrl.updateMartMenu);

// DELETE
router.delete("/:id", ctrl.deleteMartMenu);

module.exports = router;
