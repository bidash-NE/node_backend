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

// NEW: read the exact COLUMN_TYPE string (e.g. "BIGINT UNSIGNED", "INT(10) UNSIGNED")
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

// Convenience: ensure a table column matches a reference type; drop & re-add FK if needed
async function ensureColumnTypeMatches({
  table,
  column,
  refTable,
  refColumn,
  desiredType, // if null, we’ll read ref’s COLUMN_TYPE
  fkName, // FK name to (re)create
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

  // If FK exists, drop it (we’ll recreate)
  const fks = await fkConstraintNamesForColumn(table, column);
  for (const name of fks) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``
    );
  }

  // If column doesn’t exist, add it; else modify it to match
  if (curType == null) {
    await db.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${refType} NOT NULL`
    );
  } else if (curType.toUpperCase() !== refType.toUpperCase()) {
    await db.query(
      `ALTER TABLE \`${table}\` MODIFY \`${column}\` ${refType} NOT NULL`
    );
  }

  // Re-add FK with provided name
  await db.query(
    `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${fkName}\`
       FOREIGN KEY (\`${column}\`)
       REFERENCES \`${refTable}\`(\`${refColumn}\`)
       ON DELETE CASCADE ON UPDATE CASCADE`
  );
}

/* --------------- creators (unchanged parts) --------------- */
async function ensureBusinessTypesTable() {
  /* ...unchanged... */
}
async function ensureMerchantBusinessDetailsTable() {
  /* ...unchanged... */
}
async function ensureMerchantBusinessTypesTable() {
  /* ...unchanged... */
}
async function ensureFoodCategoryTable() {
  /* ...unchanged... */
}
async function ensureMartCategoryTable() {
  /* ...unchanged... */
}
async function ensureBusinessBannersTable() {
  /* ...unchanged... */
}

/* ---------- ratings per menu item (food & mart) with dynamic type matching ---------- */
async function ensureFoodMenuRatingsTable() {
  const table = "food_menu_ratings";
  if (!(await tableExists(table))) {
    // create with a placeholder type; we’ll normalize right after
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

  // Make menu_id EXACTLY the same as food_menu.id and add FK
  await ensureColumnTypeMatches({
    table,
    column: "menu_id",
    refTable: "food_menu",
    refColumn: "id",
    desiredType: null,
    fkName: "fk_fmr_menu",
  });

  // Ensure FK to users + CHECK
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

  // Make menu_id EXACTLY the same as mart_menu.id and add FK
  await ensureColumnTypeMatches({
    table,
    column: "menu_id",
    refTable: "mart_menu",
    refColumn: "id",
    desiredType: null,
    fkName: "fk_mmr_menu",
  });

  // Ensure FK to users + CHECK
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

/* --------------- migration (unchanged) --------------- */
async function migrateLegacyBusinessTypeId() {
  /* ...unchanged... */
}
async function ensureMerchantBankDetailsTable() {
  /* ...unchanged... */
}

/* --------------- entrypoint --------------- */
async function initMerchantTables() {
  await ensureBusinessTypesTable();
  await ensureMerchantBusinessDetailsTable();
  await ensureMerchantBusinessTypesTable();
  await migrateLegacyBusinessTypeId();
  await ensureMerchantBankDetailsTable();

  await ensureFoodCategoryTable();
  await ensureMartCategoryTable();

  await ensureBusinessBannersTable();

  // ratings — now dynamically matched to the FK column types
  await ensureFoodMenuRatingsTable();
  await ensureMartMenuRatingsTable();
}

module.exports = { initMerchantTables };
