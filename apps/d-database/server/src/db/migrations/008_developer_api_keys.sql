CREATE TABLE IF NOT EXISTS developer_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES database_resources(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT developer_api_keys_scopes_check
    CHECK (scopes <@ ARRAY['read', 'write']::TEXT[] AND cardinality(scopes) > 0)
);

CREATE INDEX IF NOT EXISTS developer_api_keys_resource_idx
  ON developer_api_keys (resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS developer_api_keys_user_idx
  ON developer_api_keys (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE developer_api_keys TO d_database_app;
