ALTER TABLE database_connections
  ADD COLUMN IF NOT EXISTS database_host VARCHAR(255),
  ADD COLUMN IF NOT EXISTS database_port INTEGER,
  ADD COLUMN IF NOT EXISTS database_name VARCHAR(63),
  ADD COLUMN IF NOT EXISTS database_role_name VARCHAR(63),
  ADD COLUMN IF NOT EXISTS database_password_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS database_password_iv VARCHAR(64),
  ADD COLUMN IF NOT EXISTS database_password_auth_tag VARCHAR(64);

ALTER TABLE database_connections
  ADD CONSTRAINT database_connections_database_port_check
  CHECK (database_port IS NULL OR database_port BETWEEN 1 AND 65535);

ALTER TABLE database_connections
  ADD CONSTRAINT database_connections_database_role_format_check
  CHECK (
    database_role_name IS NULL OR
    database_role_name ~ '^dsq_app_[0-9a-f]{32}$'
  );
