// controllers/martCartController.js
// Mart Cart Controller — aligned to Food controller shapes

const {
  // Optional / variant names — whichever your model actually exports will be used
  addToCartMart,

  // one of these should exist:
  getCartByUserMart,
  getCartMart,

  // one of these should exist:
  updateCartItemMart, // (cart_id, menu_id, quantity)
  updateCartMart, // (cart_item_id, quantity, special_instructions)

  // delete helpers:
  deleteCartItemMart, // prefer signature: (cart_id, menu_id) — same as Food
  deleteCartMart, // (cart_id)
} = require("../models/cartModel");

// Add to cart — request body matches Food controller
// Expecting req.body to include: { cart_id?, user_id?, items? or menu_id & quantity & special_instructions }
// Your addToCartMart should accept the full body like addToCartFood does.
// If your current model expects (cart_id, menu_id, quantity, special_instructions), you can adapt inside the model.
async function addToCart(req, res) {
  try {
    const result = await addToCartMart(req.body);
    // Return the same envelope as Food controller
    return res
      .status(200)
      .json({ message: "Items added to cart", cart_id: result?.cart_id });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to add to cart" });
  }
}

// Get cart — same as Food: user_id comes from query (?user_id=...)
async function getCart(req, res) {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    // Prefer getCartByUserMart; fallback to getCartMart(user_id)
    const data = getCartByUserMart
      ? await getCartByUserMart(user_id)
      : await getCartMart(user_id);

    if (!data) return res.status(404).json({ error: "Cart not found" });
    return res.status(200).json(data);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to retrieve cart" });
  }
}

// Update cart item — same input shape as Food: { cart_id, menu_id, quantity }
async function updateCart(req, res) {
  try {
    const { cart_id, menu_id, quantity, special_instructions } = req.body || {};
    if (!cart_id || !menu_id || typeof quantity !== "number") {
      return res
        .status(400)
        .json({ error: "cart_id, menu_id and numeric quantity are required" });
    }

    if (typeof updateCartItemMart === "function") {
      // Preferred: update by (cart_id, menu_id)
      await updateCartItemMart(
        cart_id,
        menu_id,
        quantity,
        special_instructions
      );
    } else if (typeof updateCartMart === "function") {
      // Fallback path if your model only updates by cart_item_id
      // In this fallback case, the client must pass cart_item_id in body.
      const { cart_item_id } = req.body || {};
      if (!cart_item_id) {
        return res.status(400).json({
          error:
            "cart_item_id is required when model uses updateCartMart(cart_item_id, ...)",
        });
      }
      await updateCartMart(cart_item_id, quantity, special_instructions);
    } else {
      return res
        .status(500)
        .json({ error: "No Mart update function available" });
    }

    return res.status(200).json({ message: "Cart item updated successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to update cart item" });
  }
}

// Delete cart item — same as Food: params { cart_id, menu_id }
async function deleteItem(req, res) {
  try {
    const { cart_id, menu_id, cart_item_id } = req.params || {};

    if (typeof deleteCartItemMart === "function") {
      // Prefer the Food-like signature (cart_id, menu_id) if your model supports it
      if (cart_id && menu_id) {
        await deleteCartItemMart(cart_id, menu_id);
      } else if (cart_item_id) {
        // Fallback: if your model deletes by cart_item_id only
        await deleteCartItemMart(cart_item_id);
      } else {
        return res.status(400).json({
          error:
            "cart_id and menu_id are required (or provide cart_item_id if your model deletes by item id).",
        });
      }
    } else {
      return res
        .status(500)
        .json({ error: "No Mart delete item function available" });
    }

    return res.status(200).json({ message: "Item deleted from cart" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to delete cart item" });
  }
}

// Delete entire cart — same as Food: params { cart_id }
async function deleteEntireCart(req, res) {
  try {
    const { cart_id } = req.params || {};
    if (!cart_id) return res.status(400).json({ error: "cart_id is required" });

    await deleteCartMart(cart_id);
    return res.status(200).json({ message: "Cart deleted successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to delete cart" });
  }
}

module.exports = {
  addToCart,
  getCart,
  updateCart,
  deleteItem,
  deleteEntireCart,
};
