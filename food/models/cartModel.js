// models/cartModel.js
const db = require("../config/db");

async function addToCartFood(cartData) {
  try {
    const {
      user_id,
      business_id,
      owner_type,
      fulfillment,
      business_name_snapshot,
      business_logo_snapshot,
      cart_items,
    } = cartData;

    if (
      !user_id ||
      !business_id ||
      !owner_type ||
      !cart_items ||
      !cart_items.length
    ) {
      throw new Error("Missing required fields");
    }

    // Check if cart exists for this user and owner_type
    const [cart] = await db.query(
      "SELECT id FROM carts WHERE user_id = ? AND owner_type = ? AND is_active = 1",
      [user_id, owner_type]
    );

    let cart_id;
    if (cart.length === 0) {
      // Create new cart
      const [newCart] = await db.query(
        `INSERT INTO carts 
        (user_id, business_id, owner_type, fulfillment, business_name_snapshot, business_logo_snapshot, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          user_id,
          business_id,
          owner_type,
          fulfillment,
          business_name_snapshot,
          business_logo_snapshot,
        ]
      );
      cart_id = newCart.insertId;
    } else {
      cart_id = cart[0].id;

      // Update business snapshot if changed
      await db.query(
        `UPDATE carts SET 
        business_id = ?, fulfillment = ?, business_name_snapshot = ?, business_logo_snapshot = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          business_id,
          fulfillment,
          business_name_snapshot,
          business_logo_snapshot,
          cart_id,
        ]
      );
    }

    // Insert/update each item
    for (const item of cart_items) {
      const {
        menu_id,
        item_name_snapshot,
        item_image_snapshot,
        actual_price_snapshot,
        discount_pct_snapshot,
        quantity,
        special_instructions,
      } = item;

      const [existingItem] = await db.query(
        "SELECT * FROM cart_items_food WHERE cart_id = ? AND menu_id = ?",
        [cart_id, menu_id]
      );

      if (existingItem.length > 0) {
        // Update quantity
        await db.query(
          "UPDATE cart_items_food SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE cart_id = ? AND menu_id = ?",
          [quantity, cart_id, menu_id]
        );
      } else {
        await db.query(
          `INSERT INTO cart_items_food
          (cart_id, menu_id, item_name_snapshot, item_image_snapshot, actual_price_snapshot, discount_pct_snapshot, quantity, special_instructions)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            cart_id,
            menu_id,
            item_name_snapshot,
            item_image_snapshot,
            actual_price_snapshot,
            discount_pct_snapshot,
            quantity,
            special_instructions,
          ]
        );
      }
    }

    return { cart_id };
  } catch (error) {
    console.error("addToCartFood error:", error);
    throw error;
  }
}

// Get cart by user_id
async function getCartByUser(user_id) {
  if (!user_id) throw new Error("user_id is required");

  const [cart] = await db.query(
    "SELECT * FROM carts WHERE user_id = ? AND is_active = 1",
    [user_id]
  );

  if (!cart || cart.length === 0) return null;

  const [items] = await db.query(
    "SELECT * FROM cart_items_food WHERE cart_id = ?",
    [cart[0].id]
  );

  return { cart: cart[0], items };
}

// Update item quantity
async function updateCartItem(cart_id, menu_id, quantity) {
  if (!cart_id || !menu_id || !quantity)
    throw new Error("Missing required fields");
  await db.query(
    "UPDATE cart_items_food SET quantity = ? WHERE cart_id = ? AND menu_id = ?",
    [quantity, cart_id, menu_id]
  );
  return true;
}

// Delete single item
async function deleteCartItem(cart_id, menu_id) {
  if (!cart_id || !menu_id) throw new Error("Missing required fields");
  await db.query(
    "DELETE FROM cart_items_food WHERE cart_id = ? AND menu_id = ?",
    [cart_id, menu_id]
  );
  return true;
}

// Delete entire cart
async function deleteCart(cart_id) {
  if (!cart_id) throw new Error("cart_id required");
  await db.query("DELETE FROM cart_items_food WHERE cart_id = ?", [cart_id]);
  await db.query("DELETE FROM carts WHERE id = ?", [cart_id]);
  return true;
}

module.exports = {
  addToCartFood,
  getCartByUser,
  updateCartItem,
  deleteCartItem,
  deleteCart,
};
