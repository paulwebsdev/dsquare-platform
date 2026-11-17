import { createHash, randomBytes } from "node:crypto";

export type DeveloperApiKeyMaterial = {
  secret: string;
  tokenHash: string;
  prefix: string;
};

/** Generates a one-time, high-entropy API secret and the only values persisted for it. */
export function createDeveloperApiKeyMaterial(): DeveloperApiKeyMaterial {
  const secret = `dsq_live_${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    tokenHash: createHash("sha256").update(secret).digest("hex"),
    prefix: secret.slice(0, 16),
  };
}
