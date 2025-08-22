// routes/foodMenuRoute.js
const express = require("express");
const router = express.Router();

const {
  createFoodMenuCtrl,
  listFoodMenuCtrl,
  listFoodMenuByBusinessCtrl,
  getFoodMenuByIdCtrl,
  updateFoodMenuCtrl,
  deleteFoodMenuCtrl,
} = require("../controllers/foodMenuController");

const { uploadFoodMenuImage } = require("../middlewares/uploadFoodMenuImage");

// Create (multipart OR JSON with base64)
router.post("/", uploadFoodMenuImage(), createFoodMenuCtrl);

// List (supports ?business_id=&category_name=)
router.get("/", listFoodMenuCtrl);

// All by business
router.get("/business/:business_id", listFoodMenuByBusinessCtrl);

// One by id
router.get("/:id", getFoodMenuByIdCtrl);

// Update (supports image replacement, server path, or clearing NULL; JSON base64 also OK)
router.put("/:id", uploadFoodMenuImage(), updateFoodMenuCtrl);

// Delete
router.delete("/:id", deleteFoodMenuCtrl);

module.exports = router;
