// controllers/cartController.js
const {
  addToCartFood,
  getCartByUser,
  updateCartItem,
  deleteCartItem,
  deleteCart,
} = require("../models/cartModel");

// Add to cart
async function addToCart(req, res) {
  try {
    const result = await addToCartFood(req.body);
    return res
      .status(200)
      .json({ message: "Items added to cart", cart_id: result.cart_id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Get cart
async function getCart(req, res) {
  try {
    const { user_id } = req.query;
    const data = await getCartByUser(user_id);
    if (!data) return res.status(404).json({ error: "Cart not found" });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Update cart item
async function updateCart(req, res) {
  try {
    const { cart_id, menu_id, quantity } = req.body;
    await updateCartItem(cart_id, menu_id, quantity);
    return res.status(200).json({ message: "Cart item updated successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Delete cart item
async function deleteItem(req, res) {
  try {
    const { cart_id, menu_id } = req.params;
    await deleteCartItem(cart_id, menu_id);
    return res.status(200).json({ message: "Item deleted from cart" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Delete entire cart
async function deleteEntireCart(req, res) {
  try {
    const { cart_id } = req.params;
    await deleteCart(cart_id);
    return res.status(200).json({ message: "Cart deleted successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

module.exports = {
  addToCart,
  getCart,
  updateCart,
  deleteItem,
  deleteEntireCart,
};
