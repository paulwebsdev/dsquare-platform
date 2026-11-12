import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getEncryptionKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const encoded = environment.HOSTING_SECRETS_KEY;
  if (!encoded) {
    throw new Error("HOSTING_SECRETS_KEY must be configured before environment secrets can be used.");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_LENGTH || key.toString("base64") !== encoded) {
    throw new Error("HOSTING_SECRETS_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export function encryptEnvironmentSecret(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
  context = "",
): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(environment), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptEnvironmentSecret(
  secret: EncryptedSecret,
  environment: NodeJS.ProcessEnv = process.env,
  context = "",
): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    getEncryptionKey(environment),
    Buffer.from(secret.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function isValidEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
    !name.startsWith("D_DATABASE_") &&
    !new Set(["PATH", "HOME", "PORT", "NODE_OPTIONS", "NODE_PATH", "HOSTING_SECRETS_KEY"]).has(name);
}
