export type RuntimeExecutionGateInput = {
  executionRequested: boolean;
  linuxAcceptanceApproved: boolean;
  providerConfigured: boolean;
  builderConfigured: boolean;
  persistentStorageConfigured: boolean;
  backupConfigured: boolean;
  ingressConfigured: boolean;
  trustedImageConfigured: boolean;
  privateNetworkConfigured: boolean;
};

export type RuntimeExecutionGateResult = {
  enabled: boolean;
  reasons: string[];
};

/**
 * Fail-closed production gate. CI success alone cannot enable customer code.
 * An operator must explicitly approve the dedicated Linux host after its
 * isolation checklist passes, and every runtime dependency must be present.
 */
export function evaluateRuntimeExecutionGate(
  input: RuntimeExecutionGateInput,
): RuntimeExecutionGateResult {
  const requirements: Array<[keyof RuntimeExecutionGateInput, string]> = [
    ["executionRequested", "RUNTIME_AGENT_EXECUTION_ENABLED must be explicitly true."],
    ["linuxAcceptanceApproved", "RUNTIME_AGENT_LINUX_ACCEPTANCE_APPROVED must be explicitly true after host acceptance."],
    ["providerConfigured", "The isolated Podman runtime provider is not configured."],
    ["builderConfigured", "The isolated Node.js builder is not enabled and configured."],
    ["persistentStorageConfigured", "Durable per-website persistent storage is not configured."],
    ["backupConfigured", "Encrypted persistent-storage backups are not configured."],
    ["ingressConfigured", "The private ingress admin endpoint is not configured."],
    ["trustedImageConfigured", "A pre-approved runtime image is not configured."],
    ["privateNetworkConfigured", "The private Podman network is not configured."],
  ];
  const reasons = requirements
    .filter(([key]) => input[key] !== true)
    .map(([, reason]) => reason);
  return { enabled: reasons.length === 0, reasons };
}
