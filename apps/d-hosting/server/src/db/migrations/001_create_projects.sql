CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(80) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_name_unique_idx
    ON projects (LOWER(name));

CREATE INDEX IF NOT EXISTS projects_status_created_idx
    ON projects (status, created_at DESC);