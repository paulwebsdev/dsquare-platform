ALTER TABLE database_connections
  ADD COLUMN IF NOT EXISTS database_connection_limit INTEGER NOT NULL DEFAULT 5;

ALTER TABLE database_connections
  ADD CONSTRAINT database_connections_connection_limit_check
  CHECK (database_connection_limit BETWEEN 1 AND 50);
