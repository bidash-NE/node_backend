// routes/cartRoute.js
const express = require("express");
const router = express.Router();
const {
  addToCart,
  getCart,
  updateCart,
  deleteItem,
  deleteEntireCart,
} = require("../controllers/cartController");

router.post("/add", addToCart); // Add item(s) to cart
router.get("/get", getCart); // Get cart by user_id
router.put("/update", updateCart); // Update quantity of a cart item
router.delete("/delete-item/:cart_id/:menu_id", deleteItem); // Delete single item
router.delete("/delete/:cart_id", deleteEntireCart); // Delete entire cart

module.exports = router;
