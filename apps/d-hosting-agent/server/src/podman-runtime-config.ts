export type PodmanRuntimeInput = {
  name: string;
  image: string;
  workingDirectory: "/app";
  command: ["npm", "start"];
  environment: Record<string, string>;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  user: "10001:10001";
  readOnlyRootFilesystem: true;
  capDrop: ["ALL"];
  securityOpt: ["no-new-privileges:true"];
  tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Translate the agent's narrow runtime contract into Podman's create payload.
 * No host port is published: ingress must be provided by the private proxy.
 */
export function buildPodmanContainerConfig(input: {
  resourceId: string;
  deploymentId: string;
  artifactId: string;
  runtime: PodmanRuntimeInput;
  artifactDirectory: string;
  trustedImage: string;
  networkName: string;
}): Record<string, unknown> {
  const { runtime } = input;
  if (!UUID.test(input.resourceId) || !UUID.test(input.deploymentId) || !UUID.test(input.artifactId) ||
      input.deploymentId !== input.artifactId || runtime.name !== `dsquare-deploy-${input.deploymentId}`) {
    throw new Error("Podman runtime identity is invalid.");
  }
  if (!input.artifactDirectory.startsWith("/") ||
      input.artifactDirectory.includes("\0") ||
      /[\r\n:]/.test(input.artifactDirectory)) {
    throw new Error("Podman artifact mount path must be a safe Linux absolute path.");
  }
  if (!input.trustedImage || runtime.image !== input.trustedImage) {
    throw new Error("Runtime image does not match the pre-approved image.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(input.networkName)) {
    throw new Error("Podman private network name is invalid.");
  }
  if (runtime.workingDirectory !== "/app" ||
      runtime.command.length !== 2 || runtime.command[0] !== "npm" || runtime.command[1] !== "start" ||
      runtime.user !== "10001:10001" || runtime.readOnlyRootFilesystem !== true ||
      runtime.capDrop.length !== 1 || runtime.capDrop[0] !== "ALL" ||
      runtime.securityOpt.length !== 1 || runtime.securityOpt[0] !== "no-new-privileges:true" ||
      runtime.tmpfs["/tmp"] !== "rw,noexec,nosuid,size=64m" ||
      runtime.environment.PORT !== "3000") {
    throw new Error("Runtime isolation contract is invalid.");
  }
  if (!Number.isSafeInteger(runtime.memoryBytes) || runtime.memoryBytes < 64 * 1024 * 1024 ||
      !Number.isSafeInteger(runtime.nanoCpus) || runtime.nanoCpus < 100_000_000 ||
      !Number.isInteger(runtime.pidsLimit) || runtime.pidsLimit < 16 || runtime.pidsLimit > 1024) {
    throw new Error("Runtime resource limits are invalid.");
  }

  return {
    Image: input.trustedImage,
    User: "10001:10001",
    WorkingDir: "/app",
    Cmd: ["npm", "start"],
    Env: Object.entries(runtime.environment).map(([key, value]) => `${key}=${value}`),
    ExposedPorts: { "3000/tcp": {} },
    Labels: {
      "io.dsquare.managed": "true",
      "io.dsquare.resource-id": input.resourceId,
      "io.dsquare.deployment-id": input.deploymentId,
      "io.dsquare.artifact-id": input.artifactId,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [input.networkName]: {
          // Each immutable deployment has its own alias so old and new versions
          // can coexist during readiness checks and ingress cutover.
          Aliases: [`dsquare-deploy-${input.deploymentId}.runtime.dsquare.internal`],
        },
      },
    },
    HostConfig: {
      Binds: [`${input.artifactDirectory}:/app:ro`],
      Memory: runtime.memoryBytes,
      NanoCpus: runtime.nanoCpus,
      PidsLimit: runtime.pidsLimit,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      NetworkMode: input.networkName,
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}
