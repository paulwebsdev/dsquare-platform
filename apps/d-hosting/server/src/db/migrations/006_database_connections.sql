BEGIN;

CREATE TABLE IF NOT EXISTS database_connection_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_hash CHAR(64) NOT NULL UNIQUE,
    hosting_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS database_connection_requests_user_idx
    ON database_connection_requests (hosting_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS database_connection_requests_expiry_idx
    ON database_connection_requests (expires_at);

CREATE TABLE IF NOT EXISTS database_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hosting_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    database_user_id UUID NOT NULL,
    database_project_id UUID NOT NULL,
    database_resource_id UUID NOT NULL,
    resource_name VARCHAR(80) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS database_connections_active_resource_idx
    ON database_connections (hosting_user_id, database_resource_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS database_connections_user_idx
    ON database_connections (hosting_user_id, connected_at DESC);

COMMIT;
