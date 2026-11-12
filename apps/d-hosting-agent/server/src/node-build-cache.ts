import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const NODE_BUILDER_IMAGE = "docker.io/library/node:22-bookworm-slim" as const;

export type NodeBuildCacheAttestation = {
  schemaVersion: 1;
  lockfileSha256: string;
  builderImage: typeof NODE_BUILDER_IMAGE;
  npmVersion: string;
  verifiedCacheIntegrities: string[];
  npmCacheVerified: true;
  verifiedAt: string;
  signature: string;
};

type CacheAttestationPayload = Omit<NodeBuildCacheAttestation, "signature">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSigningKey(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 32;
}

function lockfileDigest(lockfileJson: string): string {
  return createHash("sha256").update(lockfileJson, "utf8").digest("hex");
}

function canonicalPayload(payload: CacheAttestationPayload): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    lockfileSha256: payload.lockfileSha256,
    builderImage: payload.builderImage,
    npmVersion: payload.npmVersion,
    verifiedCacheIntegrities: [...payload.verifiedCacheIntegrities].sort(),
    npmCacheVerified: payload.npmCacheVerified,
    verifiedAt: payload.verifiedAt,
  });
}

function signatureFor(payload: CacheAttestationPayload, signingKey: string): string {
  return createHmac("sha256", signingKey).update(canonicalPayload(payload), "utf8").digest("hex");
}

/**
 * Returns every remote package integrity required by an npm v2/v3 lockfile.
 * Only the public npm registry and SHA-512 SRI entries are accepted. Git,
 * arbitrary URL and non-registry tarball dependencies are deliberately rejected
 * for this offline builder profile.
 */
export function getRequiredNodeCacheIntegrities(packageLockJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageLockJson);
  } catch {
    throw new Error("The npm lockfile must contain valid JSON.");
  }
  if (!isRecord(parsed) || (parsed.lockfileVersion !== 2 && parsed.lockfileVersion !== 3) ||
      !isRecord(parsed.packages)) {
    throw new Error("Only npm lockfile versions 2 and 3 with package metadata are supported.");
  }

  const integrities = new Set<string>();
  for (const [path, rawPackage] of Object.entries(parsed.packages)) {
    if (!path) continue;
    if (!isRecord(rawPackage)) throw new Error("The npm lockfile contains invalid package metadata.");
    if (rawPackage.link === true) continue;

    const resolved = rawPackage.resolved;
    if (typeof resolved !== "string") {
      throw new Error("Every non-workspace dependency must resolve to a public npm registry tarball.");
    }
    let url: URL;
    try {
      url = new URL(resolved);
    } catch {
      throw new Error("The npm lockfile contains an invalid package URL.");
    }
    if (url.protocol !== "https:" || url.origin !== "https://registry.npmjs.org" ||
        !url.pathname.startsWith("/") || url.username || url.password || url.search || url.hash) {
      throw new Error("Only HTTPS packages from registry.npmjs.org are supported by the offline builder.");
    }

    if (typeof rawPackage.integrity !== "string") {
      throw new Error("Every registry package must include a SHA-512 integrity value.");
    }
    const sha512 = rawPackage.integrity.split(/\s+/).find((item) =>
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(item),
    );
    if (!sha512) throw new Error("Every registry package must include a valid SHA-512 integrity value.");
    integrities.add(sha512);
  }
  return [...integrities].sort();
}

/**
 * Called only by the trusted cache-provisioning job after it has populated the
 * npm cache and run npm cache verify. The signing key must never enter customer
 * containers or the Hosting API request surface.
 */
export function createNodeBuildCacheAttestation(input: {
  packageLockJson: string;
  builderImage: typeof NODE_BUILDER_IMAGE;
  npmVersion: string;
  verifiedCacheIntegrities: string[];
  npmCacheVerified: true;
  verifiedAt: string;
  signingKey: string;
}): NodeBuildCacheAttestation {
  if (!validSigningKey(input.signingKey)) throw new Error("The builder cache signing key is not configured securely.");
  if (input.builderImage !== NODE_BUILDER_IMAGE) throw new Error("The builder image is not approved.");
  if (!/^10\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.npmVersion)) {
    throw new Error("The builder cache must be provisioned with the approved npm 10 toolchain.");
  }
  if (input.npmCacheVerified !== true || !Number.isFinite(Date.parse(input.verifiedAt))) {
    throw new Error("The npm cache must be verified before it can be attested.");
  }

  const required = getRequiredNodeCacheIntegrities(input.packageLockJson);
  const available = new Set(input.verifiedCacheIntegrities);
  if (required.some((integrity) => !available.has(integrity))) {
    throw new Error("The provisioned npm cache is missing one or more lockfile packages.");
  }

  const payload: CacheAttestationPayload = {
    schemaVersion: 1,
    lockfileSha256: lockfileDigest(input.packageLockJson),
    builderImage: input.builderImage,
    npmVersion: input.npmVersion,
    verifiedCacheIntegrities: [...available].sort(),
    npmCacheVerified: true,
    verifiedAt: new Date(input.verifiedAt).toISOString(),
  };
  return { ...payload, signature: signatureFor(payload, input.signingKey) };
}

/** Verifies the signed cache inventory against the exact lockfile and toolchain. */
export function verifyNodeBuildCacheAttestation(input: {
  packageLockJson: string;
  attestation: NodeBuildCacheAttestation | undefined;
  signingKey: string | undefined;
  builderImage: typeof NODE_BUILDER_IMAGE;
}): { valid: true; npmVersion: string } | { valid: false; error: string } {
  const { attestation, signingKey } = input;
  if (!attestation || !signingKey || !validSigningKey(signingKey)) {
    return { valid: false, error: "A trusted, signed npm cache attestation is required." };
  }
  if (!/^[a-f0-9]{64}$/.test(attestation.signature) ||
      !/^[a-f0-9]{64}$/.test(attestation.lockfileSha256)) {
    return { valid: false, error: "The npm cache attestation is malformed." };
  }
  if (attestation.schemaVersion !== 1 || attestation.npmCacheVerified !== true ||
      attestation.builderImage !== input.builderImage ||
      !/^10\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(attestation.npmVersion) ||
      !Number.isFinite(Date.parse(attestation.verifiedAt)) ||
      !Array.isArray(attestation.verifiedCacheIntegrities) ||
      attestation.verifiedCacheIntegrities.some((item) => typeof item !== "string")) {
    return { valid: false, error: "The npm cache attestation does not match the approved builder profile." };
  }
  if (attestation.lockfileSha256 !== lockfileDigest(input.packageLockJson)) {
    return { valid: false, error: "The npm cache was not provisioned for this exact package lockfile." };
  }

  let required: string[];
  try {
    required = getRequiredNodeCacheIntegrities(input.packageLockJson);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "The npm lockfile is unsupported." };
  }
  const available = new Set(attestation.verifiedCacheIntegrities);
  if (required.some((integrity) => !available.has(integrity))) {
    return { valid: false, error: "The signed npm cache inventory is incomplete for this lockfile." };
  }

  const { signature, ...payload } = attestation;
  const expected = Buffer.from(signatureFor(payload, signingKey), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
    return { valid: false, error: "The npm cache attestation signature is invalid." };
  }
  return { valid: true, npmVersion: attestation.npmVersion };
}
