// models/initModel.js
const db = require("../config/db");

async function indexExists(table, indexName) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
    LIMIT 1
    `,
    [table, indexName]
  );
  return rows.length > 0;
}

async function ensureIndex(table, indexName, ddlSql) {
  const exists = await indexExists(table, indexName);
  if (!exists) {
    await db.query(ddlSql);
  }
}

/**
 * Initialize (and patch) order management tables in a version-safe way.
 * - orders: adds platform_fee (order-level) if missing
 * - order_items: keeps delivery_fee (per-line) and ensures columns exist
 * - order_notification unchanged
 * - indexes created only when missing (no IF NOT EXISTS)
 */
async function initOrderManagementTable() {
  // ---------------- Orders table ----------------
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

  // Patch orders table: add platform_fee if missing
  const [orderCols] = await db.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
  `);
  const orderColSet = new Set(orderCols.map((c) => c.COLUMN_NAME));
  if (!orderColSet.has("platform_fee")) {
    await db.query(
      `ALTER TABLE orders ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`
    );
  }

  // Helpful indexes (create only if missing)
  await ensureIndex(
    "orders",
    "idx_orders_user",
    "CREATE INDEX idx_orders_user ON orders(user_id)"
  );
  await ensureIndex(
    "orders",
    "idx_orders_created",
    "CREATE INDEX idx_orders_created ON orders(created_at)"
  );

  // ---------------- Order items table ----------------
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

  // Patch order_items: ensure fee columns exist
  const [itemCols] = await db.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
  `);
  const itemColSet = new Set(itemCols.map((c) => c.COLUMN_NAME));
  if (!itemColSet.has("platform_fee")) {
    await db.query(
      `ALTER TABLE order_items ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`
    );
  }
  if (!itemColSet.has("delivery_fee")) {
    await db.query(
      `ALTER TABLE order_items ADD COLUMN delivery_fee DECIMAL(10,2) DEFAULT 0`
    );
  }

  // Indexes for order_items
  await ensureIndex(
    "order_items",
    "idx_items_order",
    "CREATE INDEX idx_items_order ON order_items(order_id)"
  );
  await ensureIndex(
    "order_items",
    "idx_items_biz_order",
    "CREATE INDEX idx_items_biz_order ON order_items(business_id, order_id)"
  );

  // ---------------- Order notification table ----------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_notification (
      notification_id CHAR(36) PRIMARY KEY,    -- UUID
      order_id VARCHAR(12) NOT NULL,
      business_id INT NOT NULL,
      user_id INT NOT NULL,
      type VARCHAR(64) NOT NULL,               -- 'order:create','order:status', etc.
      title VARCHAR(160) NOT NULL,             -- e.g. 'New order #10235'
      body_preview VARCHAR(220) NOT NULL,      -- e.g. '2× Chicken Rice · Nu 27.50'
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP NULL,
      seen_at TIMESTAMP NULL,
      INDEX idx_notif_merchant_time (business_id, created_at DESC),
      INDEX idx_notif_merchant_unread (business_id, is_read, created_at DESC),
      INDEX idx_notif_order (order_id)
    );
  `);

  console.log(
    "✅ orders, order_items, and order_notification tables are ready (version-safe indexes)."
  );
}

module.exports = { initOrderManagementTable };
