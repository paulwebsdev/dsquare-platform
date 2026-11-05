CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(254) NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
    ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx
    ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx
    ON user_sessions (expires_at);

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS owner_id UUID
    REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS projects_owner_created_idx
    ON projects (owner_id, created_at DESC);
