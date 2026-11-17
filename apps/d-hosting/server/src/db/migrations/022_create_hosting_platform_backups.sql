BEGIN;

CREATE TABLE IF NOT EXISTS hosting_platform_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 CHAR(64),
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  status VARCHAR(16) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'expired')),
  error_code VARCHAR(64),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hosting_platform_backups_retention_idx
  ON hosting_platform_backups (expires_at)
  WHERE status = 'completed' AND expires_at IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE hosting_platform_backups TO d_hosting_app';
  END IF;
END
$$;

COMMIT;
