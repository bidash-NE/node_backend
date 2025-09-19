// models/initOrderManagement.js
const db = require("../config/db");

/**
 * Initialize the order_management tables if they do not exist.
 */
async function initOrderManagementTable() {
  // Orders table (added: status_reason)
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id VARCHAR(12) PRIMARY KEY,
      user_id INT NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      discount_amount DECIMAL(10,2) DEFAULT 0,
      payment_method ENUM('COD','Wallet','Card') NOT NULL,
      delivery_address VARCHAR(500) NOT NULL,
      note_for_restaurant VARCHAR(500),
      status VARCHAR(100) DEFAULT 'PENDING',
      status_reason VARCHAR(255) NULL,
      fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery',
      priority BOOLEAN DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `);

  // Order items table
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      item_id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(12) NOT NULL,
      business_id INT NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      menu_id INT NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      item_image VARCHAR(500),
      quantity INT NOT NULL DEFAULT 1,
      price DECIMAL(10,2) NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      platform_fee DECIMAL(10,2) DEFAULT 0,
      delivery_fee DECIMAL(10,2) DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );
  `);

  console.log("✅ orders and order_items tables are ready.");
}

module.exports = { initOrderManagementTable };
