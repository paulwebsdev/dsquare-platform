import { createHash } from "node:crypto";

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export function verifyDatabaseBackupPayload(body: Buffer, expectedChecksum: string, expectedSize: number): boolean {
  const checksum = createHash("sha256").update(body).digest("hex");
  return Number.isSafeInteger(expectedSize) && expectedSize > 0 && expectedSize <= MAX_BACKUP_BYTES &&
    body.length === expectedSize && /^[a-f0-9]{64}$/i.test(expectedChecksum) && checksum === expectedChecksum.toLowerCase();
}
