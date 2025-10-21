// models/initModel.js
const db = require("../config/db");

// helper to check if a table exists
async function tableExists(table) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

// helper to read column numeric type
async function getNumericColumnMeta(table, column) {
  const [rows] = await db.query(
    `SELECT DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return rows[0] || null;
}

// ensure an index exists (create only if missing)
async function ensureIndex(table, indexName, ddlSql) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [table, indexName]
  );
  if (!rows.length) {
    await db.query(ddlSql);
  }
}

async function initWalletTables() {
  // ---------- Wallets ----------
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      wallet_id VARCHAR(20) UNIQUE,                 -- generated manually
      user_id BIGINT UNSIGNED NOT NULL UNIQUE,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,   -- ✅ Nu with 2 decimals
      status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);

  // Patch wallets.amount → DECIMAL(12,2) if needed
  const walletsAmount = await getNumericColumnMeta("wallets", "amount");
  if (
    walletsAmount &&
    (walletsAmount.DATA_TYPE !== "decimal" || walletsAmount.NUMERIC_SCALE !== 2)
  ) {
    await db.query(
      `ALTER TABLE wallets MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0.00`
    );
  }

  // ---------- Transactions ----------
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id VARCHAR(20) UNIQUE,            -- generated manually
      journal_code VARCHAR(36) NULL,                -- ✅ link DR/CR pair
      tnx_from BIGINT UNSIGNED NULL,
      tnx_to   BIGINT UNSIGNED NULL,
      amount   DECIMAL(12,2) NOT NULL,              -- ✅ Nu with 2 decimals
      remark   ENUM('CR','DR') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_journal_code (journal_code),
      KEY idx_from (tnx_from),
      KEY idx_to (tnx_to),
      CONSTRAINT fk_tx_from FOREIGN KEY (tnx_from) REFERENCES wallets(id) ON DELETE SET NULL,
      CONSTRAINT fk_tx_to   FOREIGN KEY (tnx_to)   REFERENCES wallets(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // Patch wallet_transactions.amount → DECIMAL(12,2) if needed
  const txAmount = await getNumericColumnMeta("wallet_transactions", "amount");
  if (
    txAmount &&
    (txAmount.DATA_TYPE !== "decimal" || txAmount.NUMERIC_SCALE !== 2)
  ) {
    await db.query(
      `ALTER TABLE wallet_transactions MODIFY amount DECIMAL(12,2) NOT NULL`
    );
  }

  // Ensure journal_code index exists
  await ensureIndex(
    "wallet_transactions",
    "idx_journal_code",
    "CREATE INDEX idx_journal_code ON wallet_transactions(journal_code)"
  );

  console.log(
    "✅ Wallet & Transaction tables verified (DECIMAL amounts; journal_code ready)."
  );
}

module.exports = { initWalletTables };
