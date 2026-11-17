# D Hosting and D Database PostgreSQL role isolation

This is the operator runbook for configuring least-privilege PostgreSQL identities. It does not modify any live database. Apply the SQL only after reviewing the target database, existing object ownership, and rollback plan with the database administrator.

## Role boundaries

| Identity | D Hosting | D Database | Must not have |
|---|---|---|---|
| Runtime application | `d_hosting_app`: required row-level DML on Hosting control-plane tables | `d_database_app`: required row-level DML and CREATE on the D Database database for resource schemas | SUPERUSER, CREATEDB, CREATEROLE |
| Migration | `d_hosting_migrator`: schema/table owner used only by migrations | `d_database_migrator`: schema/table owner used only by migrations | SUPERUSER; do not use it for API requests |
| Platform backup | `d_hosting_backup`: read-only pg_dump identity | `d_database_backup`: read-only pg_dump identity | INSERT, UPDATE, DELETE, CREATE, CREATEDB, CREATEROLE |
| Resource provisioner | Not used | `d_database_provisioner`: narrowly trusted role administrator for resource logins and session termination | SUPERUSER, CREATEDB; do not use it as the API runtime identity |

Production startup now fails closed if a dedicated migration connection is missing or if the migration identity is the same as the runtime identity. Both products also reject a superuser migration identity.

## D Hosting example

Run as the database administrator against the D Hosting database. Replace passwords outside source control and do not paste them into chat or logs.

```sql
CREATE ROLE d_hosting_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';
CREATE ROLE d_hosting_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';
CREATE ROLE d_hosting_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';

GRANT CONNECT ON DATABASE d_hosting TO d_hosting_migrator, d_hosting_app, d_hosting_backup;
GRANT USAGE ON SCHEMA public TO d_hosting_app, d_hosting_backup;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO d_hosting_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO d_hosting_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO d_hosting_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d_hosting_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE d_hosting_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO d_hosting_app;
ALTER DEFAULT PRIVILEGES FOR ROLE d_hosting_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO d_hosting_app;
ALTER DEFAULT PRIVILEGES FOR ROLE d_hosting_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO d_hosting_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE d_hosting_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO d_hosting_backup;
```

The DBA must ensure the migration identity owns the existing D Hosting platform schema objects (tables, sequences, and the migration ledger) before it is used. Do not make the application role the schema owner to avoid a migration setup step.

Configure the trusted D Hosting API with `DB_USER=d_hosting_app`, `DB_MIGRATION_USER=d_hosting_migrator` and its password, and `DB_BACKUP_USER=d_hosting_backup` and its password (or the corresponding dedicated connection URLs). The migration and backup credentials must never be exposed to the frontend or D Hosting Runtime Agent.

## D Database example

Run as the database administrator against the D Database database. The application role needs database-level CREATE to create isolated resource schemas, but it must not administer PostgreSQL roles.

```sql
CREATE ROLE d_database_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';
CREATE ROLE d_database_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';
CREATE ROLE d_database_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';
CREATE ROLE d_database_provisioner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT PASSWORD 'REPLACE_SECURELY';

GRANT CONNECT ON DATABASE d_database TO d_database_migrator, d_database_app, d_database_backup, d_database_provisioner;
GRANT CONNECT ON DATABASE d_database TO d_database_provisioner WITH GRANT OPTION;
REVOKE GRANT OPTION FOR CONNECT ON DATABASE d_database FROM d_database_app;
GRANT CREATE ON DATABASE d_database TO d_database_app;
GRANT USAGE ON SCHEMA public TO d_database_app, d_database_backup;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO d_database_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO d_database_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO d_database_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO d_database_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE d_database_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO d_database_app;
ALTER DEFAULT PRIVILEGES FOR ROLE d_database_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO d_database_app;
ALTER DEFAULT PRIVILEGES FOR ROLE d_database_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO d_database_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE d_database_migrator IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO d_database_backup;

GRANT d_database_app TO d_database_provisioner WITH INHERIT FALSE, SET TRUE;
GRANT pg_signal_backend TO d_database_provisioner;
```

The DBA must ensure `d_database_migrator` owns the existing D Database control-plane tables, sequences, schema, and migration ledger. Resource schemas remain owned by `d_database_app`. Do not grant CREATEROLE to `d_database_app`.

The resource provisioner must use only `DB_PROVISIONER_URL`. It checks that its connected identity is non-superuser, has CREATEROLE, can SET ROLE to `d_database_app`, and belongs to `pg_signal_backend`. It also needs CONNECT grant option on this one database so it can grant CONNECT to the resource login it creates. Role creation/password changes, database CONNECT grants, and NOLOGIN operations run as the provisioner; schema grants and grant metadata run as `d_database_app`. The old application-role CONNECT grant option is explicitly revoked above.

For resource login roles created by the previous application-role provisioner, a DBA must grant the provisioner ADMIN OPTION on each existing `dsq_app_<32-hex-id>` role before the provisioner can rotate or disable that role. Example for one reviewed role:

```sql
GRANT dsq_app_REPLACE_WITH_32_HEX_ID TO d_database_provisioner WITH ADMIN OPTION;
```

Do not grant membership in customer resource roles to the application role. The provisioner must not be used for normal API queries.

## Platform backup storage permissions

Use a different private-bucket access key for each product. Scope each key to only its product's platform-backup object prefix. The backup worker requires object-level PUT, GET (readback verification), and DELETE (failed-upload cleanup and retention). It does not need public access or bucket-wide listing. Keep website uploads, resource backup objects, and platform backup objects in separate prefixes or buckets.

The PostgreSQL backup identity must have CONNECT, schema USAGE, and SELECT on all platform tables and sequences. It must not have write, schema-creation, database-creation, or role-administration privileges. D Database's platform backup URL is separate from its application and resource-provisioner connections.

## Verification checklist

Run against each product database after the DBA configures the roles:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin
FROM pg_roles
WHERE rolname IN (
  'd_hosting_app', 'd_hosting_migrator', 'd_hosting_backup',
  'd_database_app', 'd_database_migrator', 'd_database_backup', 'd_database_provisioner'
)
ORDER BY rolname;
```

- Runtime roles are not superusers and do not have CREATEDB or CREATEROLE.
- Migration identities are distinct from runtime identities and are not superusers.
- Backup identities can SELECT platform data but cannot INSERT, UPDATE, DELETE, CREATE, CREATEDB, or CREATEROLE.
- The D Database provisioner is not a superuser or database creator; only it has CREATEROLE and pg_signal_backend for resource-role lifecycle operations.
- D Hosting and D Database use separate storage credentials and prefixes.
- Backup schedulers remain disabled until operators approve storage credentials and the environment is configured.
- Restore tests use isolated databases; do not test destructive recovery against production.

This runbook describes required configuration. It does not automatically rotate existing credentials, transfer ownership of live objects, alter production grants, or enable production schedulers. Those are explicit DBA/operator changes with a rollback plan.
