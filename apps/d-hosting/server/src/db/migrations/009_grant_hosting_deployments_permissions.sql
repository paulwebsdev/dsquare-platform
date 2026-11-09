BEGIN;

-- Neon may use its project owner directly instead of a separately provisioned
-- application role. Apply this optional grant only when that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hosting_deployments TO d_hosting_app';
  END IF;
END
$$;

COMMIT;
