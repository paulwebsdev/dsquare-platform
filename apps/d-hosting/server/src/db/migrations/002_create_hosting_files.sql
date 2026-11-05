CREATE TABLE IF NOT EXISTS hosting_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    resource_id UUID NOT NULL REFERENCES hosting_resources(id) ON DELETE RESTRICT,
    original_name VARCHAR(255) NOT NULL,
    storage_key UUID NOT NULL UNIQUE,
    mime_type VARCHAR(120) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hosting_files_resource_created_idx
    ON hosting_files (resource_id, created_at DESC);