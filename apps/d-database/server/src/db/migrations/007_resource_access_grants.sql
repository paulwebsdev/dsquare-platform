CREATE TABLE IF NOT EXISTS resource_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL UNIQUE REFERENCES database_resources(id) ON DELETE CASCADE,
  role_name VARCHAR(63) NOT NULL UNIQUE,
  status VARCHAR(12) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS resource_access_grants_status_idx
  ON resource_access_grants (status, created_at DESC);

-- The application role owns resource metadata operations. The separate
-- provisioner connection temporarily SET ROLEs to this role for these
-- parameterized SELECT/INSERT/UPDATE statements.
GRANT SELECT, INSERT, UPDATE ON TABLE resource_access_grants TO d_database_app;
