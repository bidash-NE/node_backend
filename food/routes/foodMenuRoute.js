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

// ✅ Note: Use middleware directly, DO NOT call it with ()
router.post("/", uploadFoodMenuImage, createFoodMenuCtrl);
router.get("/", listFoodMenuCtrl);
router.get("/business/:business_id", listFoodMenuByBusinessCtrl);
router.get("/:id", getFoodMenuByIdCtrl);
router.put("/:id", uploadFoodMenuImage, updateFoodMenuCtrl);
router.delete("/:id", deleteFoodMenuCtrl);

module.exports = router;
