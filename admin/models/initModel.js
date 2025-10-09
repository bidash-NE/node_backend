// models/adminLogs.init.js
const db = require("../config/db"); // mysql2/promise pool or connection

async function initAdminLogsTable() {
  // Table: admin_logs
  const sqlLogs = `
    CREATE TABLE IF NOT EXISTS admin_logs (
      log_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id      BIGINT UNSIGNED NULL,
      admin_name   VARCHAR(255) NOT NULL,
      activity     VARCHAR(255) NOT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

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

  // Table: admin_collaborators
  const sqlCollaborators = `
    CREATE TABLE IF NOT EXISTS admin_collaborators (
      collaborator_id  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name        VARCHAR(255) NOT NULL,
      contact          VARCHAR(20) NOT NULL,
      email            VARCHAR(255) NOT NULL,
      service          VARCHAR(255) DEFAULT NULL,
      role             VARCHAR(100) DEFAULT NULL,
      current_address  VARCHAR(255) DEFAULT NULL,
      cid              VARCHAR(50) DEFAULT NULL,
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (collaborator_id),
      UNIQUE KEY uniq_email (email),
      UNIQUE KEY uniq_cid (cid),
      KEY idx_role (role)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  await db.query(sqlLogs);
  await db.query(sqlCollaborators);
  console.log("✔️ admin_logs and admin_collaborators tables are ready");
}

module.exports = { initAdminLogsTable };
