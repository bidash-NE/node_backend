const express = require("express");
const router = express.Router();
const {
  addToCart,
  getCart,
  deleteCart,
  deleteItem,
  updateCart,
} = require("../controllers/cartController");

router.post("/add", addToCart); // Add item to cart
router.get("/get", getCart); // Get cart
router.delete("/delete/:cart_id", deleteCart); // Delete cart
router.delete("/delete-item/:cart_id/:item_id/:owner_type", deleteItem); // Delete item from cart
router.put("/update", updateCart); // Update cart item quantity

module.exports = router;
