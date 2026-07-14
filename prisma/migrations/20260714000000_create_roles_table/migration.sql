-- Introduce a DB-managed `roles` table so admins can add/retire account
-- roles without a code change + redeploy. Registration/login/forgot-password
-- validate against this table instead of hardcoded role lists.
--
-- `self_registrable = false` means the role can log in / reset its password
-- but cannot be granted through the public self-registration endpoint
-- (mirrors the existing "super admin" business rule).

CREATE TABLE `roles` (
  `role_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) NULL,
  `self_registrable` BOOLEAN NOT NULL DEFAULT true,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`role_id`),
  UNIQUE INDEX `roles_name_unique` (`name`)
);

INSERT INTO `roles` (`name`, `description`, `self_registrable`) VALUES
  ('user', 'Default customer/rider account', true),
  ('driver', 'Driver partner account', true),
  ('merchant', 'Merchant/business owner account', true),
  ('organizer', 'Event organizer account', true),
  ('finance', 'Internal finance staff account', true),
  ('admin', 'Internal admin staff account', true),
  ('super admin', 'Highest-privilege internal account', false);
