// initMerchantTables.js
const db = require("../config/db");

/* ---------------- helpers ---------------- */
async function tableExists(tableName) {
  const [rows] = await db.query(`SHOW TABLES LIKE ?`, [tableName]);
  return rows.length > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [tableName, indexName]
  );
  return rows.length > 0;
}

async function fkConstraintNamesForColumn(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT tc.CONSTRAINT_NAME AS name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND kcu.COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return rows.map((r) => r.name);
}

async function executeIgnoreErr(sql, params = []) {
  try {
    await db.query(sql, params);
  } catch (_e) {
    // best-effort cleanup; ignore
  }
}

/* --------------- creators --------------- */
async function ensureBusinessTypesTable() {
  if (!(await tableExists("business_types"))) {
    const sql = `
      CREATE TABLE business_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        image VARCHAR(1024) NULL,
        types VARCHAR(255) NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
    return;
  }

  // migrations for existing table
  if (!(await columnExists("business_types", "image"))) {
    await db.query(
      `ALTER TABLE business_types
         ADD COLUMN image VARCHAR(1024) NULL AFTER name`
    );
  }
}

async function ensureMerchantBusinessDetailsTable() {
  if (await tableExists("merchant_business_details")) {
    // historical add: address if missing
    if (!(await columnExists("merchant_business_details", "address"))) {
      await db.query(
        `ALTER TABLE merchant_business_details
           ADD COLUMN address VARCHAR(512) NULL AFTER longitude`
      );
    }
    // hours/holidays migrations if existing table lacks them
    if (!(await columnExists("merchant_business_details", "opening_time"))) {
      await db.query(
        `ALTER TABLE merchant_business_details
           ADD COLUMN opening_time TIME NULL AFTER delivery_option`
      );
    }
    if (!(await columnExists("merchant_business_details", "closing_time"))) {
      await db.query(
        `ALTER TABLE merchant_business_details
           ADD COLUMN closing_time TIME NULL AFTER opening_time`
      );
    }
    if (!(await columnExists("merchant_business_details", "holidays"))) {
      await db.query(
        `ALTER TABLE merchant_business_details
           ADD COLUMN holidays JSON NULL AFTER closing_time`
      );
    }
    return;
  }

  // NOTE: no business_type_id column here anymore (many-to-many via merchant_business_types)
  const sql = `
   CREATE TABLE merchant_business_details (
    business_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    owner_type VARCHAR(255) NULL,
    business_name VARCHAR(255) NOT NULL,
    business_license_number VARCHAR(100) NULL,
    license_image VARCHAR(1024) NULL,
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,
    address VARCHAR(512) NULL,
    business_logo VARCHAR(1024) NULL,
    delivery_option ENUM('SELF','GRAB','BOTH') NOT NULL DEFAULT 'SELF',
    opening_time TIME NULL,
    closing_time TIME NULL,
    holidays JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id),
    KEY idx_user_id (user_id),
    CONSTRAINT fk_mb_user FOREIGN KEY (user_id) REFERENCES users(user_id)
      ON DELETE CASCADE ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  await db.query(sql);
}

async function ensureMerchantBusinessTypesTable() {
  if (await tableExists("merchant_business_types")) return;

  const sql = `
    CREATE TABLE merchant_business_types (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      business_id BIGINT UNSIGNED NOT NULL,
      business_type_id INT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_business_type (business_id, business_type_id),
      KEY idx_mbt_business_id (business_id),
      KEY idx_mbt_business_type_id (business_type_id),
      CONSTRAINT fk_mbt_business FOREIGN KEY (business_id)
        REFERENCES merchant_business_details(business_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_mbt_business_type FOREIGN KEY (business_type_id)
        REFERENCES business_types(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  await db.query(sql);
}

/* ---------- NEW: food_category & mart_category creators ---------- */
async function ensureFoodCategoryTable() {
  if (!(await tableExists("food_category"))) {
    const sql = `
      CREATE TABLE food_category (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category_name VARCHAR(255) NOT NULL,
        business_type VARCHAR(50) NOT NULL DEFAULT 'food',
        description TEXT NULL,
        category_image VARCHAR(1024) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_food_cat (business_type, category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
    return;
  }

  // migrations
  if (!(await columnExists("food_category", "category_image"))) {
    await db.query(
      `ALTER TABLE food_category
         ADD COLUMN category_image VARCHAR(1024) NULL AFTER description`
    );
  }
  if (!(await columnExists("food_category", "business_type"))) {
    await db.query(
      `ALTER TABLE food_category
         ADD COLUMN business_type VARCHAR(50) NOT NULL DEFAULT 'food' AFTER category_name`
    );
  }
  if (!(await indexExists("food_category", "uk_food_cat"))) {
    await db.query(
      `ALTER TABLE food_category
         ADD UNIQUE KEY uk_food_cat (business_type, category_name)`
    );
  }
}

async function ensureMartCategoryTable() {
  if (!(await tableExists("mart_category"))) {
    const sql = `
      CREATE TABLE mart_category (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        category_name VARCHAR(255) NOT NULL,
        business_type VARCHAR(50) NOT NULL DEFAULT 'mart',
        description TEXT NULL,
        category_image VARCHAR(1024) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_mart_cat (business_type, category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
    await db.query(sql);
    return;
  }

  // migrations
  if (!(await columnExists("mart_category", "category_image"))) {
    await db.query(
      `ALTER TABLE mart_category
         ADD COLUMN category_image VARCHAR(1024) NULL AFTER description`
    );
  }
  if (!(await columnExists("mart_category", "business_type"))) {
    await db.query(
      `ALTER TABLE mart_category
         ADD COLUMN business_type VARCHAR(50) NOT NULL DEFAULT 'mart' AFTER category_name`
    );
  }
  if (!(await indexExists("mart_category", "uk_mart_cat"))) {
    await db.query(
      `ALTER TABLE mart_category
         ADD UNIQUE KEY uk_mart_cat (business_type, category_name)`
    );
  }
}

/* --------------- migration --------------- */
async function migrateLegacyBusinessTypeId() {
  const table = "merchant_business_details";
  const col = "business_type_id";
  const hasLegacy = await columnExists(table, col);
  if (!hasLegacy) return;

  // ensure link table before migrating
  await ensureMerchantBusinessTypesTable();

  // migrate data into link table (idempotent)
  await db.query(
    `INSERT IGNORE INTO merchant_business_types (business_id, business_type_id)
       SELECT business_id, business_type_id
         FROM ${table}
        WHERE business_type_id IS NOT NULL`
  );

  // drop foreign keys on the legacy column
  const fkNames = await fkConstraintNamesForColumn(table, col);
  for (const name of fkNames) {
    await executeIgnoreErr(`ALTER TABLE ${table} DROP FOREIGN KEY \`${name}\``);
  }

  // drop legacy index if present
  if (await indexExists(table, "idx_business_type_id")) {
    await executeIgnoreErr(
      `ALTER TABLE ${table} DROP INDEX idx_business_type_id`
    );
  }

  // finally, drop the legacy column
  await executeIgnoreErr(`ALTER TABLE ${table} DROP COLUMN ${col}`);
}

/* --------------- bank table --------------- */
async function ensureMerchantBankDetailsTable() {
  if (await tableExists("merchant_bank_details")) return;

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

/* --------------- entrypoint --------------- */
async function initMerchantTables() {
  await ensureBusinessTypesTable();
  await ensureMerchantBusinessDetailsTable();
  await ensureMerchantBusinessTypesTable();
  await migrateLegacyBusinessTypeId();
  await ensureMerchantBankDetailsTable();

  // NEW category tables
  await ensureFoodCategoryTable();
  await ensureMartCategoryTable();
}

module.exports = { initMerchantTables };
