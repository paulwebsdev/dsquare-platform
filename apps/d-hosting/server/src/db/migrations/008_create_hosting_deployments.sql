BEGIN;

CREATE TABLE IF NOT EXISTS hosting_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    resource_id UUID NOT NULL,
    deployment_number BIGINT NOT NULL CHECK (deployment_number > 0),
    status VARCHAR(12) NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    file_manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_summary VARCHAR(500),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hosting_deployments_resource_project_fk
      FOREIGN KEY (resource_id, project_id)
      REFERENCES hosting_resources (id, project_id)
      ON DELETE RESTRICT,
    CONSTRAINT hosting_deployments_resource_number_unique
      UNIQUE (resource_id, deployment_number)
);

CREATE INDEX IF NOT EXISTS hosting_deployments_resource_created_idx
    ON hosting_deployments (resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS hosting_deployments_project_created_idx
    ON hosting_deployments (project_id, created_at DESC);

COMMIT;
