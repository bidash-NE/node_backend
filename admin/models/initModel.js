// models/adminLogs.init.js
const db = require("../config/db"); // mysql2/promise pool or connection

async function initAdminLogsTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS admin_logs (
      log_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NULL,
      admin_name   VARCHAR(255) NOT NULL,
      activity   VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (log_id),
      KEY idx_user_id (user_id),
      KEY idx_created_at (created_at),

      CONSTRAINT fk_admin_logs_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;
  await db.query(sql);
  console.log("✔️ admin_logs table is ready");
}

module.exports = { initAdminLogsTable };
