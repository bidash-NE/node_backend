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
  } catch {}
}

// Read the exact COLUMN_TYPE (e.g., "BIGINT UNSIGNED")
async function getColumnType(table, column) {
  const [r] = await db.query(
    `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return r[0]?.COLUMN_TYPE || null;
}

// Ensure a table column matches a reference type; drop & re-add FK if needed
async function ensureColumnTypeMatches({
  table,
  column,
  refTable,
  refColumn,
  desiredType,
  fkName,
}) {
  const refType = desiredType || (await getColumnType(refTable, refColumn));
  if (!refType) {
    throw new Error(
      `Cannot determine type of ${refTable}.${refColumn}. Create that table first.`
    );
  }

  const [r] = await db.query(
    `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  const curType = r[0]?.COLUMN_TYPE || null;

  // Drop any existing FKs on the column
  const fks = await fkConstraintNamesForColumn(table, column);
  for (const name of fks) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``
    );
  }

  // Add/modify column to match referenced type
  if (curType == null) {
    await db.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${refType} NOT NULL`
    );
  } else if (curType.toUpperCase() !== refType.toUpperCase()) {
    await db.query(
      `ALTER TABLE \`${table}\` MODIFY \`${column}\` ${refType} NOT NULL`
    );
  }

  // Re-add FK
  await db.query(
    `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${fkName}\`
       FOREIGN KEY (\`${column}\`)
       REFERENCES \`${refTable}\`(\`${refColumn}\`)
       ON DELETE CASCADE ON UPDATE CASCADE`
  );
}

/* --------------- creators --------------- */
async function ensureBusinessTypesTable() {
  const table = "business_types";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        image VARCHAR(255),
        types VARCHAR(255),
        description TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureMerchantBusinessDetailsTable() {
  const table = "merchant_business_details";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        business_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        owner_type VARCHAR(50),
        business_name VARCHAR(255) NOT NULL,
        business_license_number VARCHAR(100),
        license_image VARCHAR(255),
        latitude DECIMAL(10,7),
        longitude DECIMAL(10,7),
        address TEXT,
        business_logo VARCHAR(255),
        delivery_option VARCHAR(50),
        complementary VARCHAR(100),
        complementary_details TEXT,
        opening_time TIME,
        closing_time TIME,
        holidays JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (business_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureMerchantBusinessTypesTable() {
  const table = "merchant_business_types";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        business_type_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (business_type_id) REFERENCES business_types(id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureFoodCategoryTable() {
  const table = "food_category";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        category_name VARCHAR(100) NOT NULL,
        business_type VARCHAR(100),
        description TEXT,
        category_image VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_category_name (category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureMartCategoryTable() {
  const table = "mart_category";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        category_name VARCHAR(100) NOT NULL,
        business_type VARCHAR(100),
        description TEXT,
        category_image VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_category_name (category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureBusinessBannersTable() {
  const table = "business_banners";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        title VARCHAR(255),
        description TEXT,
        banner_image VARCHAR(255),
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        start_date DATE,
        end_date DATE,
        owner_type ENUM('food','mart') NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_business_owner_created (business_id, owner_type, created_at),
        FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

/* ---------- FOOD MENU (full schema your model uses) ---------- */
async function ensureFoodMenuTable() {
  const table = "food_menu";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(100) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(255),
        actual_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        is_veg TINYINT(1) NOT NULL DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None',
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        stock_limit INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_food_menu_business (business_id),
        KEY idx_food_menu_cat (category_name),
        KEY idx_food_menu_available (is_available),
        UNIQUE KEY uk_foodmenu_biz_cat_name (business_id, category_name, item_name),
        FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    return;
  }

  // Migration: add any missing columns
  const addCol = async (name, defSql) => {
    if (!(await columnExists(table, name))) {
      await db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${defSql}`);
    }
  };
  await addCol("category_name", "VARCHAR(100) NOT NULL AFTER business_id");
  await addCol("item_name", "VARCHAR(255) NOT NULL AFTER category_name");
  await addCol("description", "TEXT NULL AFTER item_name");
  await addCol("item_image", "VARCHAR(255) NULL AFTER description");
  await addCol(
    "actual_price",
    "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER item_image"
  );
  await addCol(
    "discount_percentage",
    "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER actual_price"
  );
  await addCol(
    "tax_rate",
    "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER discount_percentage"
  );
  await addCol("is_veg", "TINYINT(1) NOT NULL DEFAULT 0 AFTER tax_rate");
  await addCol(
    "spice_level",
    "ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None' AFTER is_veg"
  );
  await addCol(
    "is_available",
    "TINYINT(1) NOT NULL DEFAULT 1 AFTER spice_level"
  );
  await addCol("stock_limit", "INT NOT NULL DEFAULT 0 AFTER is_available");
  await addCol("sort_order", "INT NOT NULL DEFAULT 0 AFTER stock_limit");
  await addCol("created_at", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await addCol(
    "updated_at",
    "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
  );

  if (!(await indexExists(table, "idx_food_menu_business"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_food_menu_business (business_id)`
    );
  }
  if (!(await indexExists(table, "idx_food_menu_cat"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_food_menu_cat (category_name)`
    );
  }
  if (!(await indexExists(table, "idx_food_menu_available"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_food_menu_available (is_available)`
    );
  }
  if (!(await indexExists(table, "uk_foodmenu_biz_cat_name"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD UNIQUE KEY uk_foodmenu_biz_cat_name (business_id, category_name, item_name)`
    );
  }
}

/* ---------- MART MENU (IDENTICAL to food_menu) ---------- */
async function ensureMartMenuTable() {
  const table = "mart_menu";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(100) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(255),
        actual_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        is_veg TINYINT(1) NOT NULL DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None',
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        stock_limit INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_mart_menu_business (business_id),
        KEY idx_mart_menu_cat (category_name),
        KEY idx_mart_menu_available (is_available),
        UNIQUE KEY uk_martmenu_biz_cat_name (business_id, category_name, item_name),
        FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    return;
  }

  // Migration: add any missing columns to mirror food_menu
  const addCol = async (name, defSql) => {
    if (!(await columnExists(table, name))) {
      await db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${defSql}`);
    }
  };
  await addCol("category_name", "VARCHAR(100) NOT NULL AFTER business_id");
  await addCol("item_name", "VARCHAR(255) NOT NULL AFTER category_name");
  await addCol("description", "TEXT NULL AFTER item_name");
  await addCol("item_image", "VARCHAR(255) NULL AFTER description");
  await addCol(
    "actual_price",
    "DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER item_image"
  );
  await addCol(
    "discount_percentage",
    "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER actual_price"
  );
  await addCol(
    "tax_rate",
    "DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER discount_percentage"
  );
  await addCol("is_veg", "TINYINT(1) NOT NULL DEFAULT 0 AFTER tax_rate");
  await addCol(
    "spice_level",
    "ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None' AFTER is_veg"
  );
  await addCol(
    "is_available",
    "TINYINT(1) NOT NULL DEFAULT 1 AFTER spice_level"
  );
  await addCol("stock_limit", "INT NOT NULL DEFAULT 0 AFTER is_available");
  await addCol("sort_order", "INT NOT NULL DEFAULT 0 AFTER stock_limit");
  await addCol("created_at", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await addCol(
    "updated_at",
    "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
  );

  if (!(await indexExists(table, "idx_mart_menu_business"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_mart_menu_business (business_id)`
    );
  }
  if (!(await indexExists(table, "idx_mart_menu_cat"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_mart_menu_cat (category_name)`
    );
  }
  if (!(await indexExists(table, "idx_mart_menu_available"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD KEY idx_mart_menu_available (is_available)`
    );
  }
  if (!(await indexExists(table, "uk_martmenu_biz_cat_name"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` ADD UNIQUE KEY uk_martmenu_biz_cat_name (business_id, category_name, item_name)`
    );
  }
}

/* ---------- ratings per menu item (food & mart) ---------- */
async function ensureFoodMenuRatingsTable() {
  const table = "food_menu_ratings";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        menu_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        rating TINYINT UNSIGNED NOT NULL,
        comment TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fmr_menu (menu_id),
        KEY idx_fmr_user (user_id),
        KEY idx_fmr_rating (rating),
        UNIQUE KEY uk_fmr_menu_user (menu_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  if (!(await tableExists("food_menu"))) await ensureFoodMenuTable();

  await ensureColumnTypeMatches({
    table,
    column: "menu_id",
    refTable: "food_menu",
    refColumn: "id",
    desiredType: null,
    fkName: "fk_fmr_menu",
  });

  const userFks = await fkConstraintNamesForColumn(table, "user_id");
  if (!userFks.length) {
    await db.query(
      `ALTER TABLE \`${table}\`
         ADD CONSTRAINT fk_fmr_user
         FOREIGN KEY (user_id) REFERENCES users(user_id)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
  await executeIgnoreErr(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT chk_fmr_rating CHECK (rating BETWEEN 1 AND 5)`
  );
}

async function ensureMartMenuRatingsTable() {
  const table = "mart_menu_ratings";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        menu_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        rating TINYINT UNSIGNED NOT NULL,
        comment TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_mmr_menu (menu_id),
        KEY idx_mmr_user (user_id),
        KEY idx_mmr_rating (rating),
        UNIQUE KEY uk_mmr_menu_user (menu_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  if (!(await tableExists("mart_menu"))) await ensureMartMenuTable();

  await ensureColumnTypeMatches({
    table,
    column: "menu_id",
    refTable: "mart_menu",
    refColumn: "id",
    desiredType: null,
    fkName: "fk_mmr_menu",
  });

  const userFks = await fkConstraintNamesForColumn(table, "user_id");
  if (!userFks.length) {
    await db.query(
      `ALTER TABLE \`${table}\`
         ADD CONSTRAINT fk_mmr_user
         FOREIGN KEY (user_id) REFERENCES users(user_id)
         ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
  await executeIgnoreErr(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT chk_mmr_rating CHECK (rating BETWEEN 1 AND 5)`
  );
}

/* -------- merchant_bank_details (user_id required, business_id optional) -------- */
async function ensureMerchantBankDetailsTable() {
  const table = "merchant_bank_details";

  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        bank_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        business_id BIGINT UNSIGNED NULL DEFAULT NULL,
        bank_name VARCHAR(255) NOT NULL,
        account_holder_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(50) NOT NULL,
        bank_qr_code_image TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bank_id),
        KEY idx_mbd_user (user_id),
        KEY idx_mbd_business (business_id),
        CONSTRAINT fk_mbd_user
          FOREIGN KEY (user_id)
          REFERENCES users(user_id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_mbd_business
          FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE SET NULL ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  } else {
    await ensureColumnTypeMatches({
      table,
      column: "business_id",
      refTable: "merchant_business_details",
      refColumn: "business_id",
      desiredType: null,
      fkName: "fk_mbd_business",
    });

    await ensureColumnTypeMatches({
      table,
      column: "user_id",
      refTable: "users",
      refColumn: "user_id",
      desiredType: null,
      fkName: "fk_mbd_user",
    });

    if (!(await indexExists(table, "idx_mbd_business"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_mbd_business (business_id)`
      );
    }
    if (!(await indexExists(table, "idx_mbd_user"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_mbd_user (user_id)`
      );
    }
  }
}

/* --------------- migrations (safe no-ops / guards) --------------- */
async function migrateLegacyBusinessTypeId() {
  try {
    const table = "merchant_business_details";
    const hasOld = await columnExists(table, "business_type_id");
    if (hasOld) {
      // no-op placeholder
    }
  } catch {}
}

/* --------------- entrypoint --------------- */
async function initMerchantTables() {
  // Core business taxonomy
  await ensureBusinessTypesTable();
  await ensureMerchantBusinessDetailsTable();
  await ensureMerchantBusinessTypesTable();
  await migrateLegacyBusinessTypeId();

  // Bank details
  await ensureMerchantBankDetailsTable();

  // Categories & banners
  await ensureFoodCategoryTable();
  await ensureMartCategoryTable();
  await ensureBusinessBannersTable();

  // Base menu tables (MUST exist before ratings & before controllers query them)
  await ensureFoodMenuTable();
  await ensureMartMenuTable(); // <- now identical to food_menu

  // Ratings (FKs to menu tables)
  await ensureFoodMenuRatingsTable();
  await ensureMartMenuRatingsTable();
}

module.exports = { initMerchantTables };
