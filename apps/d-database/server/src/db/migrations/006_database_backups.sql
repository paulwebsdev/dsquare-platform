BEGIN;
CREATE TABLE IF NOT EXISTS database_backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    resource_id UUID NOT NULL REFERENCES database_resources(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 's3-compatible'
        CHECK (provider IN ('s3-compatible')),
    object_key TEXT,
    checksum_sha256 CHAR(64),
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'restoring', 'restored')),
    error_code VARCHAR(64),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    restored_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT database_backups_resource_project_fk
        FOREIGN KEY (resource_id, project_id)
        REFERENCES database_resources(id, project_id)
        ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS database_backups_project_created_idx
    ON database_backups (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS database_backups_resource_created_idx
    ON database_backups (resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS database_backups_retention_idx
    ON database_backups (expires_at)
    WHERE status = 'completed' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS database_backups_pending_idx
    ON database_backups (started_at)
    WHERE status IN ('pending', 'running', 'restoring');
COMMIT;
