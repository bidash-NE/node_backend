const db = require("../config/db");

/* ----------------------- helpers ----------------------- */
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
  if (!exists) await db.query(ddlSql);
}

async function columnExists(table, column) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [table, column]
  );
  return rows.length > 0;
}

async function getEnumDefinition(table, column) {
  const [[row]] = await db.query(
    `
    SELECT COLUMN_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [table, column]
  );
  return row ? String(row.COLUMN_TYPE || "") : "";
}

/* Replace enum with a normalized one if needed */
async function ensurePaymentMethodEnum() {
  // Normalize to ENUM('COD','WALLET','CARD')
  const desired = `enum('COD','WALLET','CARD')`;
  const current = await getEnumDefinition("orders", "payment_method");
  if (!current) return; // column created below (fresh DB)
  if (current.toLowerCase() === desired.toLowerCase()) return;

  await db.query(`
    ALTER TABLE orders
    MODIFY COLUMN payment_method ENUM('COD','WALLET','CARD') NOT NULL
  `);
}

/* ------------------- main initializer ------------------- */
/**
 * Initialize (and patch) order management tables in a version-safe way.
 * - orders: ensures platform_fee and normalized payment_method ENUM
 * - order_items: ensures fee columns
 * - order_notification: as required (with indexes)
 * - order_wallet_captures: idempotency marker for wallet/COD captures
 * NOTE: We DO NOT touch wallet_transactions here (it already exists in your wallet service init).
 */
async function initOrderManagementTable() {
  /* -------- Orders -------- */
  await db.query(`
 -- ✅ MASTER orders table (delivery_fee + platform_fee included)
CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(12) PRIMARY KEY,
  user_id INT NOT NULL,

  total_amount DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT 0,

  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,   -- total delivery fee for the order
  platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0,   -- total platform fee for the order
  merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL, -- delivery cost borne by merchant (for free delivery cases)
  payment_method ENUM('COD','WALLET','CARD') NOT NULL,
  delivery_address VARCHAR(500) NOT NULL,
  note_for_restaurant VARCHAR(500),
  if_unavailable VARCHAR(256),
  status VARCHAR(100) DEFAULT 'PENDING',
  status_reason VARCHAR(255) NULL,
  fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery',
  priority BOOLEAN DEFAULT 0,
  estimated_arrivial_time VARCHAR(40) DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

`);

  if (!(await columnExists("orders", "platform_fee"))) {
    await db.query(
      `ALTER TABLE orders ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`
    );
  }
  await ensurePaymentMethodEnum();

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

  /* -------- Order items -------- */
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

  if (!(await columnExists("order_items", "platform_fee"))) {
    await db.query(
      `ALTER TABLE order_items ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`
    );
  }
  if (!(await columnExists("order_items", "delivery_fee"))) {
    await db.query(
      `ALTER TABLE order_items ADD COLUMN delivery_fee DECIMAL(10,2) DEFAULT 0`
    );
  }

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

  /* -------- Order notification -------- */
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_notification (
      notification_id CHAR(36) PRIMARY KEY,    -- UUID
      order_id VARCHAR(12) NOT NULL,
      business_id INT NOT NULL,
      user_id INT NOT NULL,
      type VARCHAR(64) NOT NULL,             
      title VARCHAR(160) NOT NULL,           
      body_preview VARCHAR(220) NOT NULL,     
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP NULL,
      seen_at TIMESTAMP NULL,
      INDEX idx_notif_merchant_time (business_id, created_at DESC),
      INDEX idx_notif_merchant_unread (business_id, is_read, created_at DESC),
      INDEX idx_notif_order (order_id)
    );
  `);

  /* -------- Order wallet captures (idempotency) -------- */
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_wallet_captures (
      order_id      VARCHAR(32) NOT NULL,
      capture_type  VARCHAR(32) NOT NULL,   -- WALLET_FULL | COD_FEE
      captured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      buyer_txn_id  VARCHAR(64) DEFAULT NULL,
      merch_txn_id  VARCHAR(64) DEFAULT NULL,
      admin_txn_id  VARCHAR(64) DEFAULT NULL,
      PRIMARY KEY (order_id, capture_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log(
    "✅ orders, order_items, order_notification, order_wallet_captures are ready (version-safe)."
  );
}

module.exports = { initOrderManagementTable };
