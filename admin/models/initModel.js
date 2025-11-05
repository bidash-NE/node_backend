// models/adminLogs.init.js
const db = require("../config/db"); // mysql2/promise pool or connection

async function initAdminLogsTable() {
  /* =======================================================
     1. ADMIN LOGS TABLE
  ======================================================= */
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

  /* =======================================================
     2. ADMIN COLLABORATORS TABLE (keep if used elsewhere)
  ======================================================= */
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

  /* =======================================================
     3. SYSTEM NOTIFICATIONS TABLE (NO scheduled_at)
  ======================================================= */
  const sqlNotifications = `
    CREATE TABLE IF NOT EXISTS system_notifications (
      id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title             VARCHAR(255) NOT NULL,
      message           TEXT NOT NULL,
      delivery_channels JSON NOT NULL DEFAULT (JSON_ARRAY()),
      target_audience   JSON NOT NULL DEFAULT (JSON_ARRAY()),
      created_by        BIGINT UNSIGNED DEFAULT NULL,
      sent_at           DATETIME DEFAULT NULL,
      status            ENUM('pending','sent','failed') DEFAULT 'sent',
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (id),
      KEY idx_status (status),
      KEY idx_created_at (created_at),

      CONSTRAINT fk_notifications_user
        FOREIGN KEY (created_by) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await db.query(sqlLogs);
    await db.query(sqlCollaborators);
    await db.query(sqlNotifications);
    console.log(
      "✔️ admin_logs, admin_collaborators, and system_notifications tables are ready"
    );
  } catch (err) {
    console.error("❌ Error initializing admin tables:", err);
  }
}

module.exports = { initAdminLogsTable };
