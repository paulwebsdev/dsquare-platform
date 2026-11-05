CREATE TABLE IF NOT EXISTS hosting_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    name VARCHAR(80) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    site_type VARCHAR(20) NOT NULL DEFAULT 'static'
        CHECK (site_type IN ('static')),
    status VARCHAR(12) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS hosting_resources_project_name_idx
    ON hosting_resources (project_id, LOWER(name));

CREATE INDEX IF NOT EXISTS hosting_resources_project_created_idx
    ON hosting_resources (project_id, created_at DESC);