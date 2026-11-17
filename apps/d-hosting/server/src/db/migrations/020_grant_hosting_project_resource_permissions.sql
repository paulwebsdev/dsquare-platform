BEGIN;

-- The Hosting API uses the restricted d_hosting_app role in production.
-- Earlier migrations granted this role access to deployment and integration
-- tables, but omitted the core project and website-resource tables. Without
-- these grants, listing/creating websites fails with PostgreSQL 42501.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd_hosting_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects, hosting_resources TO d_hosting_app';
  END IF;
END
$$;

COMMIT;
