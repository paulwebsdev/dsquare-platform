BEGIN;

CREATE TABLE IF NOT EXISTS hosting_authorization_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash CHAR(64) NOT NULL UNIQUE,
    client_id VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES database_resources(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hosting_authorization_codes_expiry_idx
    ON hosting_authorization_codes (expires_at);

CREATE INDEX IF NOT EXISTS hosting_authorization_codes_user_idx
    ON hosting_authorization_codes (user_id, created_at DESC);

COMMIT;
