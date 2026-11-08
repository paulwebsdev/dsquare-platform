BEGIN;

ALTER TABLE hosting_resources
  DROP CONSTRAINT IF EXISTS hosting_resources_site_type_check;

ALTER TABLE hosting_resources
  ADD CONSTRAINT hosting_resources_site_type_check
  CHECK (site_type IN ('static', 'node'));

COMMIT;
