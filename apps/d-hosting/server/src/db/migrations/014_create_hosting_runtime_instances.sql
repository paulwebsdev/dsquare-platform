BEGIN;

-- Persist one isolated runtime record per website. This is orchestration metadata
-- only; no customer process is started by this migration or by the API alone.
CREATE TABLE IF NOT EXISTS hosting_runtime_instances (
    resource_id UUID PRIMARY KEY REFERENCES hosting_resources(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL DEFAULT 'none',
    provider_instance_id VARCHAR(255),
    status VARCHAR(16) NOT NULL DEFAULT 'stopped',
    deployment_id UUID REFERENCES hosting_deployments(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    exit_code INTEGER,
    error_summary VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hosting_runtime_instances_provider_check
      CHECK (provider IN ('none', 'podman', 'docker', 'mock')),
    CONSTRAINT hosting_runtime_instances_status_check
      CHECK (status IN ('queued', 'preparing', 'starting', 'running', 'stopping', 'stopped', 'failed'))
);

CREATE INDEX IF NOT EXISTS hosting_runtime_instances_status_idx
    ON hosting_runtime_instances (status, updated_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hosting_runtime_instances TO d_hosting_app';
  END IF;
END
$$;

COMMIT;
