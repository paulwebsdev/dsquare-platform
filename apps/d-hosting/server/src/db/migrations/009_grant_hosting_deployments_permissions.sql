BEGIN;

-- The hosting API connects with the least-privilege application role.
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE hosting_deployments
TO d_hosting_app;

COMMIT;
