export const MAX_RUNTIME_ENVIRONMENT_VARIABLES = 100;
export const MAX_RUNTIME_ENVIRONMENT_BYTES = 64 * 1024;

/**
 * Checks the aggregate environment budget for one website. The caller must
 * exclude the variable being replaced and serialize writes for the resource.
 */
export function getRuntimeEnvironmentCapacityError(
  existingCount: number,
  existingBytes: number,
  nextValueBytes: number,
): string | null {
  if (
    !Number.isSafeInteger(existingCount) || existingCount < 0 ||
    !Number.isSafeInteger(existingBytes) || existingBytes < 0 ||
    !Number.isSafeInteger(nextValueBytes) || nextValueBytes < 1
  ) {
    throw new Error("Runtime environment capacity values are invalid.");
  }

  if (existingCount >= MAX_RUNTIME_ENVIRONMENT_VARIABLES) {
    return `A website can have at most ${MAX_RUNTIME_ENVIRONMENT_VARIABLES} environment variables.`;
  }
  if (existingBytes + nextValueBytes > MAX_RUNTIME_ENVIRONMENT_BYTES) {
    return "The website's combined environment variable values exceed the 64 KiB limit.";
  }
  return null;
}
