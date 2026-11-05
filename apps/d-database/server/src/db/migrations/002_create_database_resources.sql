CREATE TABLE IF NOT EXISTS database_resources (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    name VARCHAR(80) NOT NULL,
    engine VARCHAR(32) NOT NULL DEFAULT 'postgresql',
    schema_name VARCHAR(63) NOT NULL UNIQUE,
    status VARCHAR(12) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS database_resources_project_name_idx
    ON database_resources (project_id, LOWER(name));

CREATE INDEX IF NOT EXISTS database_resources_project_created_idx
    ON database_resources (project_id, created_at DESC);