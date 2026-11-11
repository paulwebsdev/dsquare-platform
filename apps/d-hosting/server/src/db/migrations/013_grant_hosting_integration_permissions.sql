BEGIN;

-- Keep schema ownership with the migration role while granting the runtime
-- application role only the row operations required by its API routes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE database_connection_requests, database_connections, hosting_custom_domains
      TO d_hosting_app;
  END IF;
END
$$;

COMMIT;
