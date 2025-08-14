const db = require("../config/db");

async function tableExists(tableName) {
  const [rows] = await db.query(`SHOW TABLES LIKE ?`, [tableName]);
  return rows.length > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function initMerchantTables() {
  // Create business_types table if it doesn't exist
  if (!(await tableExists("business_types"))) {
    const sql = `
      CREATE TABLE business_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
         types VARCHAR(255) NULL,     
        description TEXT,                       
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
  }

  // Create merchant_business_details table if it doesn't exist
  if (!(await tableExists("merchant_business_details"))) {
    const sql = `
      CREATE TABLE merchant_business_details (
        business_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
         owner_type VARCHAR(255) NULL,
        business_name VARCHAR(255) NOT NULL,
        business_type_id INT UNSIGNED,  -- Foreign key to business_types table
        business_license_number VARCHAR(100) NULL,
        license_image VARCHAR(1024) NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        address VARCHAR(512) NULL,
        business_logo VARCHAR(1024) NULL,
        delivery_option ENUM('SELF','GRAB','BOTH') NOT NULL DEFAULT 'SELF',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (business_id),
        KEY idx_user_id (user_id),
        KEY idx_business_type_id (business_type_id),  -- Index on business type
        CONSTRAINT fk_mb_user FOREIGN KEY (user_id) REFERENCES users(user_id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_mb_business_type FOREIGN KEY (business_type_id) REFERENCES business_types(id)
          ON DELETE SET NULL ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
  } else {
    // Add address if missing (silent)
    if (!(await columnExists("merchant_business_details", "address"))) {
      await db.query(
        `ALTER TABLE merchant_business_details
         ADD COLUMN address VARCHAR(512) NULL AFTER longitude`
      );
    }

    // Add business_type_id if missing (silent)
    if (
      !(await columnExists("merchant_business_details", "business_type_id"))
    ) {
      await db.query(
        `ALTER TABLE merchant_business_details
         ADD COLUMN business_type_id INT UNSIGNED AFTER business_name`
      );
    }
  }

  // Create merchant_bank_details table if it doesn't exist
  if (!(await tableExists("merchant_bank_details"))) {
    const sql = `
      CREATE TABLE merchant_bank_details (
        bank_detail_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        bank_name VARCHAR(150) NOT NULL,
        account_holder_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(64) NOT NULL,
        bank_card_front_image VARCHAR(1024) NULL,
        bank_card_back_image VARCHAR(1024) NULL,
        bank_qr_code_image VARCHAR(1024) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bank_detail_id),
        KEY idx_user_id (user_id),
        CONSTRAINT fk_mbd_user FOREIGN KEY (user_id) REFERENCES users(user_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
  }
}

module.exports = { initMerchantTables };
