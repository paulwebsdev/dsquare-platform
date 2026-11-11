export type DatabaseBackupStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

const REQUIRED = [
  "D_DATABASE_BACKUP_ENDPOINT",
  "D_DATABASE_BACKUP_BUCKET",
  "D_DATABASE_BACKUP_ACCESS_KEY_ID",
  "D_DATABASE_BACKUP_SECRET_ACCESS_KEY",
] as const;

export function getDatabaseBackupStorageConfig(
  env: NodeJS.ProcessEnv,
): DatabaseBackupStorageConfig | null {
  const supplied = REQUIRED.filter((key) => Boolean(env[key]?.trim()));
  if (supplied.length === 0) return null;
  if (supplied.length !== REQUIRED.length) {
    const missing = REQUIRED.filter((key) => !env[key]?.trim());
    throw new Error(`Incomplete D Database backup storage configuration: ${missing.join(", ")}`);
  }

  const endpointValue = env.D_DATABASE_BACKUP_ENDPOINT!.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error("D_DATABASE_BACKUP_ENDPOINT must be a valid URL.");
  }

  const production = env.NODE_ENV === "production";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    !["https:", ...(production ? [] : ["http:"])].includes(endpoint.protocol) ||
    (production && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (production && loopback)
  ) {
    throw new Error("D_DATABASE_BACKUP_ENDPOINT must use HTTPS in production and must not contain credentials, query strings or fragments.");
  }

  const bucket = env.D_DATABASE_BACKUP_BUCKET!.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("D_DATABASE_BACKUP_BUCKET is not a valid bucket name.");
  }

  const prefix = (env.D_DATABASE_BACKUP_PREFIX || "dsquare-d-database").trim();
  if (
    !prefix ||
    prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix.split("/").some((part) => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))
  ) {
    throw new Error("D_DATABASE_BACKUP_PREFIX contains an unsafe path.");
  }

  const region = (env.D_DATABASE_BACKUP_REGION || "auto").trim();
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(region)) {
    throw new Error("D_DATABASE_BACKUP_REGION is invalid.");
  }

  return {
    endpoint: endpoint.origin,
    region,
    bucket,
    accessKeyId: env.D_DATABASE_BACKUP_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.D_DATABASE_BACKUP_SECRET_ACCESS_KEY!,
    prefix,
  };
}
