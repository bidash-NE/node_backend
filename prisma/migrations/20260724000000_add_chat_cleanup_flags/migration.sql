ALTER TABLE `cancelled_orders`
  ADD COLUMN `chat_cleaned` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX `idx_cancelled_chat_cleaned` (`chat_cleaned`, `cancelled_at`);

ALTER TABLE `delivered_orders`
  ADD COLUMN `chat_cleaned` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX `idx_delivered_chat_cleaned` (`chat_cleaned`, `delivered_at`);
