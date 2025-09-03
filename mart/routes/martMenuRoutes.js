// routes/martMenuRoute.js
const express = require("express");
const router = express.Router();

const {
  createMartMenuCtrl,
  listMartMenuCtrl,
  listMartMenuByBusinessCtrl,
  getMartMenuByIdCtrl,
  updateMartMenuCtrl,
  deleteMartMenuCtrl,
} = require("../controllers/martMenuController");

const { uploadMartMenuImage } = require("../middlewares/uploadMartMenuImage");

// Create (multipart OR JSON with base64)
router.post("/", uploadMartMenuImage(), createMartMenuCtrl);

// List (supports ?business_id=&category_name=)
router.get("/", listMartMenuCtrl);

// All by business
router.get("/business/:business_id", listMartMenuByBusinessCtrl);

// One by id
router.get("/:id", getMartMenuByIdCtrl);

// Update (supports image replacement, server path, or clearing NULL; JSON base64 also OK)
router.put("/:id", uploadMartMenuImage(), updateMartMenuCtrl);

// Delete
router.delete("/:id", deleteMartMenuCtrl);

module.exports = router;
