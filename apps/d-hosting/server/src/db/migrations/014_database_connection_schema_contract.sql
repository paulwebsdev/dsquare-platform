BEGIN;

-- Persist the private PostgreSQL schema identity returned by D Database.
-- This is metadata for the server-side runtime contract, not a credential.
ALTER TABLE database_connections
  ADD COLUMN IF NOT EXISTS database_schema_name VARCHAR(63);

ALTER TABLE database_connections
  ADD CONSTRAINT database_connections_schema_name_format_check
  CHECK (
    database_schema_name IS NULL OR
    database_schema_name ~ '^db_[0-9a-f]{32}$'
  );

COMMIT;
