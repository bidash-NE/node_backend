-- Adds the signup event-credit ledger tables and the credit_applied column on event_bookings.
-- Run manually against the shared MySQL database (not wired into src/db/migrate.js, which is stale).

CREATE TABLE IF NOT EXISTS event_credits (
  user_id    BIGINT UNSIGNED NOT NULL,
  balance    INT NOT NULL DEFAULT 0,
  granted    INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS event_credit_usages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  booking_id VARCHAR(50) NULL,
  amount     INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_credit_usage_user (user_id),
  KEY idx_credit_usage_booking (booking_id)
);

ALTER TABLE event_bookings
  ADD COLUMN IF NOT EXISTS credit_applied INT NOT NULL DEFAULT 0 AFTER wallet_journal_code;
