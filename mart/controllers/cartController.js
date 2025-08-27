const {
  addToCartMart,
  getCartMart,
  getCartItemsMart,
  deleteCartItemMart,
  deleteCartMart,
  updateCartMart,
} = require("../models/cartModel");

async function addToCart(req, res) {
  try {
    const { cart_id, menu_id, quantity, special_instructions } = req.body;
    const result = await addToCartMart(
      cart_id,
      menu_id,
      quantity,
      special_instructions
    );
    return res
      .status(200)
      .json({ message: "Item added to cart", data: result });
  } catch (err) {
    console.error("addToCart error:", err);
    return res.status(500).json({ error: "Failed to add item to cart" });
  }
}

async function getCart(req, res) {
  try {
    const { user_id } = req.params;
    const result = await getCartMart(user_id);
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error("getCart error:", err);
    return res.status(500).json({ error: "Failed to retrieve cart" });
  }
}

async function getCartItems(req, res) {
  try {
    const { cart_id } = req.params;
    const result = await getCartItemsMart(cart_id);
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error("getCartItems error:", err);
    return res.status(500).json({ error: "Failed to retrieve cart items" });
  }
}

async function deleteCartItem(req, res) {
  try {
    const { cart_item_id } = req.params;
    await deleteCartItemMart(cart_item_id);
    return res.status(200).json({ message: "Cart item deleted" });
  } catch (err) {
    console.error("deleteCartItem error:", err);
    return res.status(500).json({ error: "Failed to delete cart item" });
  }
}

async function deleteCart(req, res) {
  try {
    const { cart_id } = req.params;
    await deleteCartMart(cart_id);
    return res.status(200).json({ message: "Cart deleted" });
  } catch (err) {
    console.error("deleteCart error:", err);
    return res.status(500).json({ error: "Failed to delete cart" });
  }
}

async function updateCart(req, res) {
  try {
    const { cart_item_id, quantity, special_instructions } = req.body;
    const result = await updateCartMart(
      cart_item_id,
      quantity,
      special_instructions
    );
    return res.status(200).json({ message: "Cart updated", data: result });
  } catch (err) {
    console.error("updateCart error:", err);
    return res.status(500).json({ error: "Failed to update cart" });
  }
}

module.exports = {
  addToCart,
  getCart,
  getCartItems,
  deleteCartItem,
  deleteCart,
  updateCart,
};
