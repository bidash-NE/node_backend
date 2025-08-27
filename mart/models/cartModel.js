const db = require("../../config/db");

async function addToCartMart(cart_id, menu_id, quantity, special_instructions) {
  const [menuRow] = await db.query(
    "SELECT id, actual_price, item_name FROM mart_menu WHERE id = ?",
    [menu_id]
  );

  if (!menuRow.length) {
    throw new Error("Menu item not found");
  }

  const { actual_price, item_name } = menuRow[0];

  await db.query(
    `
    INSERT INTO cart_items_mart (cart_id, menu_id, item_name_snapshot, actual_price_snapshot, quantity, special_instructions)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    [cart_id, menu_id, item_name, actual_price, quantity, special_instructions]
  );

  return { cart_id, menu_id, quantity, special_instructions, item_name };
}

async function getCartMart(user_id) {
  const [cartRows] = await db.query(
    `
    SELECT id, business_id, owner_type, is_active, note_for_merchant
    FROM carts
    WHERE user_id = ? AND is_active = 1
  `,
    [user_id]
  );

  return cartRows;
}

async function getCartItemsMart(cart_id) {
  const [itemsRows] = await db.query(
    `
    SELECT ci.id, ci.item_name_snapshot, ci.actual_price_snapshot, ci.quantity, ci.special_instructions, m.item_image
    FROM cart_items_mart ci
    JOIN mart_menu m ON ci.menu_id = m.id
    WHERE ci.cart_id = ?
  `,
    [cart_id]
  );

  return itemsRows;
}

async function deleteCartItemMart(cart_item_id) {
  await db.query("DELETE FROM cart_items_mart WHERE id = ?", [cart_item_id]);
}

async function deleteCartMart(cart_id) {
  await db.query("DELETE FROM cart_items_mart WHERE cart_id = ?", [cart_id]);
  await db.query("DELETE FROM carts WHERE id = ?", [cart_id]);
}

async function updateCartMart(cart_item_id, quantity, special_instructions) {
  const [itemRow] = await db.query(
    "SELECT id FROM cart_items_mart WHERE id = ?",
    [cart_item_id]
  );
  if (!itemRow.length) throw new Error("Cart item not found");

  await db.query(
    `
    UPDATE cart_items_mart
    SET quantity = ?, special_instructions = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    [quantity, special_instructions, cart_item_id]
  );

  return { cart_item_id, quantity, special_instructions };
}

module.exports = {
  addToCartMart,
  getCartMart,
  getCartItemsMart,
  deleteCartItemMart,
  deleteCartMart,
  updateCartMart,
};
