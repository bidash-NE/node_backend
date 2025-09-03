// routes/martCartRoute.js
const express = require("express");
const router = express.Router();

const {
  addToCart,
  getCart,
  updateCart,
  deleteItem,
  deleteEntireCart,
} = require("../controllers/cartController");

// Add item(s) to cart
router.post("/add", addToCart);

// Get cart by user_id (expects ?user_id=... in query)
router.get("/get", getCart);

// Update quantity of a cart item
router.put("/update", updateCart);

// Delete single item
router.delete("/delete-item/:cart_id/:menu_id", deleteItem);

// Delete entire cart
router.delete("/delete/:cart_id", deleteEntireCart);

module.exports = router;
