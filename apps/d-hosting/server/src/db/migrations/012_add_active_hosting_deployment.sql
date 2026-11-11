BEGIN;

-- A published website must point to one immutable, successful deployment.
ALTER TABLE hosting_resources
  ADD COLUMN IF NOT EXISTS active_deployment_id UUID;

ALTER TABLE hosting_resources
  ADD CONSTRAINT hosting_resources_active_deployment_fk
  FOREIGN KEY (active_deployment_id)
  REFERENCES hosting_deployments(id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS hosting_resources_active_deployment_idx
  ON hosting_resources (active_deployment_id)
  WHERE active_deployment_id IS NOT NULL;

COMMIT;
