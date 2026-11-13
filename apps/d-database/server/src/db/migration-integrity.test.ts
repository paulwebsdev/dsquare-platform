import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMigrationChecksum,
  getMigrationChecksum,
  MigrationIntegrityError,
  validateMigrationFilenames,
} from "./migration-integrity.js";

test("validates and orders numbered migration filenames", () => {
  assert.deepEqual(
    validateMigrationFilenames(["008_developer_api_keys.sql", "001_create_projects.sql"]),
    ["001_create_projects.sql", "008_developer_api_keys.sql"],
  );
});

test("rejects filenames without a three-digit version and safe slug", () => {
  for (const name of ["migration.sql", "1_create.sql", "009 Bad.sql", "../010_escape.sql"]) {
    assert.throws(() => validateMigrationFilenames([name]), MigrationIntegrityError);
  }
});

test("rejects duplicate migration version numbers", () => {
  assert.throws(
    () => validateMigrationFilenames(["009_add_users.sql", "009_add_roles.sql"]),
    /Duplicate migration version 009/,
  );
});

test("calculates stable SHA-256 checksums and ignores a UTF-8 BOM", () => {
  assert.equal(getMigrationChecksum("SELECT 1;"), getMigrationChecksum("\\uFEFFSELECT 1;"));
  assert.match(getMigrationChecksum("SELECT 1;"), /^[a-f0-9]{64}$/);
});

test("accepts matching checksums and rejects changed applied migrations", () => {
  const checksum = getMigrationChecksum("SELECT 1;");
  assert.doesNotThrow(() => assertMigrationChecksum("001_test.sql", checksum, checksum));
  assert.throws(
    () => assertMigrationChecksum("001_test.sql", checksum, "0".repeat(64)),
    /has changed since it was recorded/,
  );
});

test("allows one-time checksum adoption for migrations applied before checksums existed", () => {
  assert.doesNotThrow(() => assertMigrationChecksum("001_test.sql", "a".repeat(64), null));
});
