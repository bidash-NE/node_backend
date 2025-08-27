const { addToCartFood } = require("../models/cartModel");
const db = require("../config/db");

// Add an item to the cart
async function addToCart(req, res) {
  try {
    const {
      user_id,
      business_id,
      owner_type,
      fulfillment,
      note_for_merchant,
      cart_items,
    } = req.body;

    // Check for missing fields
    if (
      !user_id ||
      !business_id ||
      !owner_type ||
      !cart_items ||
      !cart_items.length
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: user_id, business_id, owner_type, cart_items",
      });
    }

    const errors = [];
    const itemsToInsert = [];

    // Loop through each item and validate
    for (const item of cart_items) {
      const { menu_id, quantity, special_instructions } = item;

      // Check if menu_id and quantity are present
      if (!menu_id || !quantity) {
        errors.push(`Item with menu_id ${menu_id} is missing required fields.`);
        continue;
      }

      // Query the menu item from the database (food or mart)
      const [menuItem] = await db.query(
        owner_type === "food"
          ? "SELECT * FROM food_menu WHERE id = ?"
          : "SELECT * FROM mart_menu WHERE id = ?",
        [menu_id]
      );

      if (!menuItem || menuItem.length === 0) {
        errors.push(`Menu item with id ${menu_id} not found.`);
        continue;
      }

      // Add item details to insert into the cart
      itemsToInsert.push({
        user_id,
        business_id,
        menu_id,
        quantity: quantity || 1,
        item_name_snapshot: menuItem[0].item_name,
        item_image_snapshot: menuItem[0].item_image,
        actual_price_snapshot: menuItem[0].actual_price,
        discount_pct_snapshot: menuItem[0].discount_percentage,
        special_instructions,
      });
    }

    // If there are validation errors, return them
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(", ") });
    }

    // Prepare the cart data (info about the cart itself)
    const cartData = {
      user_id,
      business_id,
      owner_type,
      fulfillment,
      note_for_merchant,
      itemsToInsert, // Pass the items to insert
    };

    // Call the model function to insert cart data and items into the database
    const result = await addToCartFood(cartData);

    return res.status(200).json({
      message: "Items added to cart successfully",
      data: result,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to add items to cart" });
  }
}

// Get cart details
async function getCart(req, res) {
  try {
    const { user_id, business_id, owner_type } = req.query;

    if (!user_id || !business_id || !owner_type) {
      return res.status(400).json({
        error: "Required query parameters: user_id, business_id, owner_type",
      });
    }

    // Query the cart details
    const [cart] = await db.query(
      `SELECT * FROM carts WHERE user_id = ? AND business_id = ? AND owner_type = ? AND is_active = 1`,
      [user_id, business_id, owner_type]
    );

    if (!cart || cart.length === 0) {
      return res.status(404).json({ error: "Cart not found" });
    }

    // Query the cart items
    const itemsQuery =
      owner_type === "food"
        ? `SELECT * FROM cart_items_food WHERE cart_id = ?`
        : `SELECT * FROM cart_items_mart WHERE cart_id = ?`;

    const items = await db.query(itemsQuery, [cart[0].id]);

    return res.status(200).json({ cart: cart[0], items });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to fetch cart" });
  }
}

// Delete cart
async function deleteCart(req, res) {
  try {
    const { cart_id } = req.params;

    if (!cart_id) {
      return res.status(400).json({ error: "cart_id is required" });
    }

    const [cart] = await db.query("SELECT * FROM carts WHERE id = ?", [
      cart_id,
    ]);

    if (!cart || cart.length === 0) {
      return res.status(404).json({ error: "Cart not found" });
    }

    await db.query("DELETE FROM cart_items_food WHERE cart_id = ?", [cart_id]);
    await db.query("DELETE FROM cart_items_mart WHERE cart_id = ?", [cart_id]);
    await db.query("DELETE FROM carts WHERE id = ?", [cart_id]);

    return res.status(200).json({ message: "Cart deleted successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to delete cart" });
  }
}

// Delete a specific item from the cart
async function deleteItem(req, res) {
  try {
    const { cart_id, item_id, owner_type } = req.params;

    if (!cart_id || !item_id || !owner_type) {
      return res
        .status(400)
        .json({ error: "cart_id, item_id, and owner_type are required" });
    }

    const deleteQuery =
      owner_type === "food"
        ? `DELETE FROM cart_items_food WHERE cart_id = ? AND menu_id = ?`
        : `DELETE FROM cart_items_mart WHERE cart_id = ? AND menu_id = ?`;

    await db.query(deleteQuery, [cart_id, item_id]);

    return res
      .status(200)
      .json({ message: "Item removed from cart successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to remove item from cart" });
  }
}

// Update the quantity of an item in the cart
async function updateCart(req, res) {
  try {
    const { cart_id, menu_id, quantity } = req.body;

    if (!cart_id || !menu_id || !quantity) {
      return res
        .status(400)
        .json({ error: "cart_id, menu_id, and quantity are required" });
    }

    const [cart] = await db.query("SELECT * FROM carts WHERE id = ?", [
      cart_id,
    ]);

    if (!cart || cart.length === 0) {
      return res.status(404).json({ error: "Cart not found" });
    }

    const updateQuery =
      cart[0].owner_type === "food"
        ? `UPDATE cart_items_food SET quantity = ? WHERE cart_id = ? AND menu_id = ?`
        : `UPDATE cart_items_mart SET quantity = ? WHERE cart_id = ? AND menu_id = ?`;

    await db.query(updateQuery, [quantity, cart_id, menu_id]);

    return res.status(200).json({ message: "Cart updated successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to update cart" });
  }
}

module.exports = {
  addToCart,
  getCart,
  deleteCart,
  deleteItem,
  updateCart,
};
