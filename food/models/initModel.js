const db = require("../config/db");

async function initMenuTables() {
  try {
    // ===== FOOD MENU TABLE =====
    await db.query(`
     CREATE TABLE IF NOT EXISTS food_menu (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id BIGINT UNSIGNED NOT NULL,         -- NEW
  category_name VARCHAR(255) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  description TEXT,
  item_image VARCHAR(500),
  base_price DECIMAL(10,2) NOT NULL,
  tax_rate DECIMAL(5,2) DEFAULT 0.00,
  is_veg TINYINT(1) DEFAULT 0,
  spice_level ENUM('None','Mild','Medium','Hot') DEFAULT 'None',
  is_available TINYINT(1) DEFAULT 1,
  stock_limit INT DEFAULT 0,
  sort_order INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_foodmenu_business (business_id),
  KEY idx_foodmenu_category (category_name),
  UNIQUE KEY uq_foodmenu_unique (business_id, category_name, item_name),

  CONSTRAINT fk_foodmenu_business FOREIGN KEY (business_id)
    REFERENCES merchant_business_details(business_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
    `);

    // ===== MART MENU TABLE =====
    await db.query(`
     CREATE TABLE IF NOT EXISTS mart_menu (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id BIGINT UNSIGNED NOT NULL,
  category_name VARCHAR(255) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  description TEXT,
  item_image VARCHAR(500),
  base_price DECIMAL(10,2) NOT NULL,
  tax_rate DECIMAL(5,2) DEFAULT 0.00,
  is_veg TINYINT(1) DEFAULT 0,
  spice_level ENUM('None','Mild','Medium','Hot') DEFAULT 'None',
  is_available TINYINT(1) DEFAULT 1,
  stock_limit INT DEFAULT 0,
  sort_order INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_martmenu_business (business_id),
  KEY idx_martmenu_category (category_name),
  UNIQUE KEY uq_martmenu_unique (business_id, category_name, item_name),

  CONSTRAINT fk_martmenu_business FOREIGN KEY (business_id)
    REFERENCES merchant_business_details(business_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
    `);

    console.log("✅ food_menu and mart_menu tables ensured.");
  } catch (err) {
    console.error("❌ Error creating menu tables:", err);
  }
}

module.exports = initMenuTables;
