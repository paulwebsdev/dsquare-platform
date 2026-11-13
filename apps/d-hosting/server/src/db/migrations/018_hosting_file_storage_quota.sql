ALTER TABLE hosting_resources
  ADD COLUMN IF NOT EXISTS file_storage_quota_bytes BIGINT NOT NULL DEFAULT 104857600;

ALTER TABLE hosting_resources
  DROP CONSTRAINT IF EXISTS hosting_resources_file_storage_quota_check;

ALTER TABLE hosting_resources
  ADD CONSTRAINT hosting_resources_file_storage_quota_check
  CHECK (file_storage_quota_bytes >= 1048576 AND file_storage_quota_bytes <= 10737418240);
