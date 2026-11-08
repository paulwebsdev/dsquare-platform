export type RuntimeLimits = {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  startupTimeoutMs: number;
};

function readNumber(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

/**
 * Central, bounded resource limits for future container creation.
 * These values are configuration only; they do not start or execute containers.
 */
export function getRuntimeLimits(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeLimits {
  const memoryMb = readNumber(environment, "HOSTING_RUNTIME_MEMORY_MB", 256);
  const cpuCores = readNumber(environment, "HOSTING_RUNTIME_CPU_CORES", 0.5);
  const pidsLimit = readNumber(environment, "HOSTING_RUNTIME_PIDS_LIMIT", 128);
  const startupTimeoutMs = readNumber(environment, "HOSTING_RUNTIME_STARTUP_TIMEOUT_MS", 30_000);

  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 4096) {
    throw new Error("HOSTING_RUNTIME_MEMORY_MB must be an integer between 64 and 4096.");
  }
  if (cpuCores < 0.1 || cpuCores > 4) {
    throw new Error("HOSTING_RUNTIME_CPU_CORES must be between 0.1 and 4.");
  }
  if (!Number.isInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 1024) {
    throw new Error("HOSTING_RUNTIME_PIDS_LIMIT must be an integer between 16 and 1024.");
  }
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 5_000 || startupTimeoutMs > 120_000) {
    throw new Error("HOSTING_RUNTIME_STARTUP_TIMEOUT_MS must be between 5000 and 120000.");
  }

  return {
    memoryBytes: memoryMb * 1024 * 1024,
    nanoCpus: Math.floor(cpuCores * 1_000_000_000),
    pidsLimit,
    startupTimeoutMs,
  };
}
