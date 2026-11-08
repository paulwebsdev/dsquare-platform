export type RuntimeState =
  | "queued"
  | "preparing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

const TRANSITIONS: Record<RuntimeState, readonly RuntimeState[]> = {
  queued: ["preparing", "failed"],
  preparing: ["starting", "failed"],
  starting: ["running", "failed"],
  running: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: ["queued"],
  failed: ["queued"],
};

/**
 * Validates a runtime state change before it is persisted by the deployment
 * service. It deliberately performs no process or container operations.
 */
export function transitionRuntimeState(
  current: RuntimeState,
  next: RuntimeState,
): RuntimeState {
  if (!TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid runtime state transition: ${current} -> ${next}.`);
  }
  return next;
}

export function canRetryRuntime(state: RuntimeState): boolean {
  return state === "failed" || state === "stopped";
}
