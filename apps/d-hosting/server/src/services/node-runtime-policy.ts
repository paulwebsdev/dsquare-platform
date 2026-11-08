import type { NodeProjectValidation } from "./node-project-validation.js";

export type NodeRuntimePolicyInput = {
  siteType: string;
  resourceStatus: string;
  validation: NodeProjectValidation;
  isolatedRuntimeAvailable: boolean;
};

export type NodeRuntimePolicy =
  | { allowed: true }
  | { allowed: false; status: 409 | 422; reason: string };

/**
 * Keeps Node deployment disabled until a real isolated runtime provider is
 * configured. Project validation alone is never treated as execution safety.
 */
export function evaluateNodeRuntimePolicy(
  input: NodeRuntimePolicyInput,
): NodeRuntimePolicy {
  if (input.siteType !== "node") {
    return { allowed: false, status: 409, reason: "This operation is only available for Node.js websites." };
  }
  if (input.resourceStatus === "archived") {
    return { allowed: false, status: 409, reason: "Restore this website before deploying." };
  }
  if (!input.validation.valid) {
    return { allowed: false, status: 422, reason: input.validation.error };
  }
  if (!input.isolatedRuntimeAvailable) {
    return {
      allowed: false,
      status: 409,
      reason: "Node.js execution is unavailable until an isolated runtime provider is configured.",
    };
  }
  return { allowed: true };
}
