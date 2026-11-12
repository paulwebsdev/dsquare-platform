BEGIN;

CREATE TABLE IF NOT EXISTS hosting_resource_database_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hosting_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hosting_resource_id UUID NOT NULL REFERENCES hosting_resources(id) ON DELETE CASCADE,
  database_connection_id UUID NOT NULL REFERENCES database_connections(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hosting_resource_database_connections_one_per_website
    UNIQUE (hosting_resource_id)
);

CREATE INDEX IF NOT EXISTS hosting_resource_database_connections_user_idx
  ON hosting_resource_database_connections (hosting_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS hosting_resource_database_connections_database_idx
  ON hosting_resource_database_connections (database_connection_id);

COMMIT;
