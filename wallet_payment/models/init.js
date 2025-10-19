const db = require("../config/db");

// helper to check if table exists
async function tableExists(table) {
  const [rows] = await db.query(
    `
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    LIMIT 1
    `,
    [table]
  );
  return rows.length > 0;
}

async function initWalletTables() {
  // ---------- Wallet Table ----------
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      wallet_id VARCHAR(20) UNIQUE,                -- generated manually
      user_id BIGINT UNSIGNED NOT NULL UNIQUE,
      amount BIGINT NOT NULL DEFAULT 0,
      status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);

  // ---------- Transaction Table ----------
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      transaction_id VARCHAR(20) UNIQUE,           -- generated manually
      tnx_from BIGINT UNSIGNED NULL,
      tnx_to   BIGINT UNSIGNED NULL,
      amount   BIGINT NOT NULL,
      remark   ENUM('CR','DR') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_from (tnx_from),
      KEY idx_to (tnx_to),
      CONSTRAINT fk_tx_from FOREIGN KEY (tnx_from) REFERENCES wallets(id) ON DELETE SET NULL,
      CONSTRAINT fk_tx_to   FOREIGN KEY (tnx_to)   REFERENCES wallets(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  console.log("✅ Wallet and Transaction tables verified / created.");
}

module.exports = { initWalletTables };
