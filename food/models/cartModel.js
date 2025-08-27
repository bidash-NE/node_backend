const db = require("../config/db");

async function addToCartFood(cartData) {
  try {
    const {
      user_id,
      business_id,
      itemsToInsert, // Expecting items to insert directly
    } = cartData;

    // Validate required fields
    if (!user_id || !business_id || !itemsToInsert || !itemsToInsert.length) {
      throw new Error(
        "Missing required fields: user_id, business_id, itemsToInsert"
      );
    }

    // Check if the cart exists for the user and business
    const [cart] = await db.query(
      `
      SELECT id FROM carts
      WHERE user_id = ? AND business_id = ? AND owner_type = 'food' AND is_active = 1
    `,
      [user_id, business_id]
    );

    let cart_id;
    if (cart.length === 0) {
      // Create a new cart if not exists
      const [newCart] = await db.query(
        `
        INSERT INTO carts (user_id, business_id, owner_type, is_active)
        VALUES (?, ?, 'food', 1)
      `,
        [user_id, business_id]
      );

      cart_id = newCart.insertId;
    } else {
      cart_id = cart[0].id;
    }

    // Add each item to the cart
    for (const item of itemsToInsert) {
      const {
        menu_id,
        quantity,
        item_name_snapshot,
        item_image_snapshot,
        actual_price_snapshot,
        discount_pct_snapshot,
        special_instructions,
      } = item;

      // Check if the menu item exists
      const [menuItem] = await db.query(
        "SELECT * FROM food_menu WHERE id = ?",
        [menu_id]
      );
      if (!menuItem || menuItem.length === 0) {
        throw new Error(`Menu item with id ${menu_id} not found`);
      }

      // Check if the item already exists in the cart
      const [existingItem] = await db.query(
        `
        SELECT * FROM cart_items_food WHERE cart_id = ? AND menu_id = ?
      `,
        [cart_id, menu_id]
      );

      if (existingItem.length > 0) {
        // Update the existing item if it's already in the cart
        await db.query(
          `
          UPDATE cart_items_food
          SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
          WHERE cart_id = ? AND menu_id = ?
        `,
          [quantity, cart_id, menu_id]
        );
      } else {
        // Otherwise, insert the new item
        await db.query(
          `
          INSERT INTO cart_items_food 
          (cart_id, menu_id, item_name_snapshot, item_image_snapshot, actual_price_snapshot, discount_pct_snapshot, quantity, special_instructions)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
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

    return { message: "Items added to cart successfully" };
  } catch (error) {
    console.error("Error in addToCartFood: ", error);
    throw new Error(error.message || "Error adding items to cart");
  }
}

module.exports = { addToCartFood };
