// routes/foodMenuRoute.js
const express = require("express");
const router = express.Router();

const {
  createFoodMenuCtrl,
  listFoodMenuCtrl,
  listFoodMenuByBusinessCtrl, // NEW
  getFoodMenuByIdCtrl,
  updateFoodMenuCtrl,
  deleteFoodMenuCtrl,
} = require("../controllers/foodMenuController");

const { uploadFoodMenuImage } = require("../middleware/uploadFoodMenuImage");

// Create (supports multipart/form-data for item_image or image)
router.post("/", uploadFoodMenuImage(), createFoodMenuCtrl);

// List (supports filters ?business_id=&category_name=)
router.get("/", listFoodMenuCtrl);

// Get ALL by business (clean path)
router.get("/business/:business_id", listFoodMenuByBusinessCtrl);

// Get single by id
router.get("/:id", getFoodMenuByIdCtrl);

// Update (supports image replacement)
router.put("/:id", uploadFoodMenuImage(), updateFoodMenuCtrl);

// Delete
router.delete("/:id", deleteFoodMenuCtrl);

module.exports = router;
