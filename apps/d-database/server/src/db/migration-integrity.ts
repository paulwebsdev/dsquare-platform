import { createHash } from "node:crypto";

const MIGRATION_FILENAME = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

export function validateMigrationFilenames(fileNames: string[]): string[] {
  const versions = new Map<string, string>();

  for (const fileName of fileNames) {
    const match = MIGRATION_FILENAME.exec(fileName);
    if (!match) {
      throw new MigrationIntegrityError("Invalid migration filename: " + fileName);
    }

    const version = match[1];
    if (Number(version) < 1) {
      throw new MigrationIntegrityError("Migration version must be greater than zero: " + fileName);
    }
    const existing = versions.get(version);
    if (existing) {
      throw new MigrationIntegrityError(
        "Duplicate migration version " + version + ": " + existing + " and " + fileName,
      );
    }
    versions.set(version, fileName);
  }

  return [...fileNames].sort((left, right) => left.localeCompare(right));
}

export function getMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/^\uFEFF/, ""), "utf8").digest("hex");
}

export function assertMigrationChecksum(
  fileName: string,
  expected: string,
  actual: string | null,
): void {
  if (actual !== null && actual !== expected) {
    throw new MigrationIntegrityError(
      "Applied migration integrity check failed: " + fileName + " has changed since it was recorded.",
    );
  }
}
