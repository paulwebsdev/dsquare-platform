import {
  decryptEnvironmentSecret,
  isValidEnvironmentName,
  type EncryptedSecret,
} from "./environment-secrets.js";

export type EncryptedEnvironmentVariable = EncryptedSecret & {
  name: string;
};

/**
 * Decrypts only the selected resource's stored variables for an internal runtime
 * hand-off. Callers must never log or return this object through an API response.
 */
export function buildRuntimeEnvironment(
  resourceId: string,
  variables: EncryptedEnvironmentVariable[],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!resourceId.trim()) {
    throw new Error("A resource ID is required to prepare runtime environment variables.");
  }

  const runtimeEnvironment: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const variable of variables) {
    if (!isValidEnvironmentName(variable.name)) {
      throw new Error("Stored environment contains an invalid or reserved variable name.");
    }
    if (Object.prototype.hasOwnProperty.call(runtimeEnvironment, variable.name)) {
      throw new Error("Stored environment contains duplicate variable names.");
    }

    runtimeEnvironment[variable.name] = decryptEnvironmentSecret(
      {
        ciphertext: variable.ciphertext,
        iv: variable.iv,
        authTag: variable.authTag,
      },
      environment,
      `${resourceId}:${variable.name}`,
    );
  }

  return runtimeEnvironment;
}
