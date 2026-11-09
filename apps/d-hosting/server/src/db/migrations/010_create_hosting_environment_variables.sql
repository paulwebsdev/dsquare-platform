BEGIN;

CREATE TABLE IF NOT EXISTS hosting_environment_variables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id UUID NOT NULL REFERENCES hosting_resources(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    encrypted_value TEXT NOT NULL,
    encryption_iv VARCHAR(64) NOT NULL,
    encryption_auth_tag VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hosting_environment_variables_resource_name_unique
      UNIQUE (resource_id, name)
);

CREATE INDEX IF NOT EXISTS hosting_environment_variables_resource_idx
    ON hosting_environment_variables (resource_id, name);

-- Apply the optional least-privilege grant only if this role is provisioned.
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON hosting_environment_variables TO d_hosting_app';
  END IF;
END
$;

COMMIT;
