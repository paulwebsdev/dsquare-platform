BEGIN;

-- These composite keys let PostgreSQL verify ownership and resource/project
-- membership, not merely that each referenced row exists.
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_owner_id_unique_idx
    ON projects (id, owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS database_resources_id_project_id_unique_idx
    ON database_resources (id, project_id);

CREATE TABLE IF NOT EXISTS hosting_authorization_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash CHAR(64) NOT NULL UNIQUE,
    client_id VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    resource_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT hosting_authorization_codes_project_owner_fk
        FOREIGN KEY (project_id, user_id)
        REFERENCES projects (id, owner_id)
        ON DELETE CASCADE,

    CONSTRAINT hosting_authorization_codes_resource_project_fk
        FOREIGN KEY (resource_id, project_id)
        REFERENCES database_resources (id, project_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hosting_authorization_codes_expiry_idx
    ON hosting_authorization_codes (expires_at);

CREATE INDEX IF NOT EXISTS hosting_authorization_codes_user_idx
    ON hosting_authorization_codes (user_id, created_at DESC);

COMMIT;
