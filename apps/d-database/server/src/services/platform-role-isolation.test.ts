import assert from "node:assert/strict";
import testRunner from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFile(resolve(here, path), "utf8");

const [
  databaseIndex,
  databaseConfig,
  hostingIndex,
  hostingConfig,
  hostingBackupWorker,
  databaseBackupWorker,
] = await Promise.all([
  read("../index.ts"),
  read("../config/database.ts"),
  read("../../../../d-hosting/server/src/index.ts"),
  read("../../../../d-hosting/server/src/config/database.ts"),
  read("../../../../d-hosting/server/src/services/platform-backup-worker.ts"),
  read("database-backup-worker.ts"),
]);

testRunner("D Database runtime role is not elevated by startup reconciliation", () => {
  assert.doesNotMatch(databaseIndex, /ALTER ROLE d_database_app CREATEROLE/i);
  assert.doesNotMatch(databaseIndex, /GRANT CONNECT[^;]*WITH GRANT OPTION[^;]*TO d_database_app/i);
  assert.match(databaseIndex, /GRANT CONNECT, CREATE ON DATABASE/);
  assert.match(databaseIndex, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO d_database_app/);
  assert.match(databaseIndex, /REVOKE ALL ON TABLE dsquare_schema_migrations FROM d_database_app/);
  assert.match(databaseIndex, /runtime_can_create_roles/);
  assert.match(databaseIndex, /assertResourceProvisionerReady\(\)/);
  assert.match(databaseIndex, /DB_PROVISIONER_URL/);
  assert.match(databaseIndex, /can_grant_connect/);
});

testRunner("both products require a distinct, non-elevated production migration identity", () => {
  for (const config of [databaseConfig, hostingConfig]) {
    assert.match(config, /NODE_ENV === "production" && migrationPool === pool/);
    assert.match(config, /DB_MIGRATION_URL or DB_MIGRATION_USER/);
  }
  for (const index of [databaseIndex, hostingIndex]) {
    assert.match(index, /runtimeIdentity\.rows\[0\].*role_name/);
    assert.match(index, /migrationIdentity\.rows\[0\].*role_name/);
    assert.match(index, /migrationIdentity\.rows\[0\].*rolsuper/);
    assert.match(index, /rolcreatedb/);
    assert.match(index, /rolcreaterole/);
    assert.match(index, /can_read_server_files/);
    assert.match(index, /can_execute_server_program/);
  }
});

testRunner("D Hosting runtime grants are applied through the migration identity only", () => {
  assert.match(hostingIndex, /ensureHostingRuntimePrivileges\(migrationPool\)/);
  assert.match(hostingIndex, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO d_hosting_app/);
  assert.match(hostingIndex, /REVOKE ALL ON TABLE dsquare_schema_migrations FROM d_hosting_app/);
  assert.doesNotMatch(hostingIndex, /pool\.query\("GRANT SELECT, INSERT, UPDATE, DELETE/);
});

testRunner("platform backup workers use dedicated database backup connection variables", () => {
  assert.match(hostingBackupWorker, /process\.env\.DB_BACKUP_URL/);
  assert.match(hostingBackupWorker, /dedicated read-only DB_BACKUP_URL/);
  assert.match(databaseBackupWorker, /process\.env\.D_DATABASE_PLATFORM_BACKUP_URL/);
  assert.doesNotMatch(databaseBackupWorker.slice(databaseBackupWorker.indexOf("export async function runDatabasePlatformBackup"), databaseBackupWorker.indexOf("export async function runDatabasePlatformBackupRetention")), /DATABASE_URL\?\.trim\(\)/);
});
