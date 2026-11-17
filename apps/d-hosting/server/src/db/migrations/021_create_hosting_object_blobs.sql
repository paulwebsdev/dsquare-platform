BEGIN;

CREATE TABLE IF NOT EXISTS hosting_object_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES hosting_resources(id) ON DELETE CASCADE,
  object_id UUID NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  body BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hosting_object_blobs_body_size_check
    CHECK (octet_length(body) = size_bytes),
  CONSTRAINT hosting_object_blobs_identity_unique
    UNIQUE (owner_id, project_id, resource_id, object_id)
);

CREATE INDEX IF NOT EXISTS hosting_object_blobs_resource_created_idx
  ON hosting_object_blobs (resource_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE hosting_object_blobs TO d_hosting_app';
  END IF;
END
$$;

COMMIT;
