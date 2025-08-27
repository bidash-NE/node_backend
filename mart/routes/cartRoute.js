const express = require("express");
const router = express.Router();
const {
  addToCart,
  getCart,
  getCartItems,
  deleteCartItem,
  deleteCart,
  updateCart,
} = require("../controllers/cartController");

router.post("/add", addToCart); // Add an item to the cart
router.get("/:user_id", getCart); // Get the cart for the user
router.get("/items/:cart_id", getCartItems); // Get the items in the cart
router.delete("/item/:cart_item_id", deleteCartItem); // Delete an item from the cart
router.delete("/:cart_id", deleteCart); // Delete the cart
router.put("/update", updateCart); // Update cart item

module.exports = router;
