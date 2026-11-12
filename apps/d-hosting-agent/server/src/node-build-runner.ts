import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PodmanApiClient, type PodmanTransport } from "./podman-client.js";
import {
  createRuntimeArtifactBundle,
  readStoredArtifact,
  storeRuntimeArtifact,
  verifyStoredArtifactContents,
} from "./artifact-store.js";
import { createNodeBuildPlan } from "./node-build-policy.js";
import { provisionNodeBuildCache } from "./node-build-cache-provisioner.js";
import type { NodeBuildCacheAttestation } from "./node-build-cache.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILDER_IMAGE = "docker.io/library/node:22-bookworm-slim";
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;

export type NodeBuildRequest = {
  sourceArtifactId: string;
  deploymentId: string;
  cacheAttestation?: NodeBuildCacheAttestation;
  limits?: { memoryBytes?: number; nanoCpus?: number; pidsLimit?: number; timeoutMs?: number; maxOutputBytes?: number };
};

export type NodeBuildResult = {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  output: string;
};

export type NodeBuildRunnerOptions = {
  transport: PodmanTransport;
  storageRoot: string;
  workspaceRoot: string;
  cacheRoot: string;
  signingKey: string;
  /** Map host paths to paths visible inside the rootless Podman service. */
  containerPath: (hostPath: string) => string;
  builderImage?: string;
  allowRegistryEgress: boolean;
};

function ensureSafeLinuxMount(value: string): string {
  if (!value.startsWith("/") || value.includes(":") || /[\r\n\0]/.test(value)) {
    throw new Error("Builder bind mount path must be a safe Linux absolute path.");
  }
  return value;
}

async function copyVerifiedTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const copy = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      const source = path.join(sourceDirectory, entry.name);
      const destination = path.join(destinationDirectory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) throw new Error("Builder input cannot contain symbolic links.");
      if (metadata.isDirectory()) {
        await mkdir(destination, { mode: 0o700 });
        await copy(source, destination);
        continue;
      }
      if (!metadata.isFile()) throw new Error("Builder input contains an unsupported filesystem entry.");
      const input = await open(source, "r");
      const output = await open(destination, "wx", 0o600);
      try {
        const opened = await input.stat();
        if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
          throw new Error("Builder input changed while being copied.");
        }
        const bytes = await input.readFile();
        if (bytes.byteLength !== metadata.size) throw new Error("Builder input changed while being copied.");
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await input.close();
        await output.close();
      }
    }
  };
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  await copy(sourceRoot, destinationRoot);
}

function parseArtifactPaths(metadataJson: string): string[] {
  const value = JSON.parse(metadataJson) as { files?: unknown };
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2_000) {
    throw new Error("Stored source artifact manifest is invalid.");
  }
  const paths = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string") {
      throw new Error("Stored source artifact manifest contains an invalid path.");
    }
    return (entry as { path: string }).path;
  });
  return paths;
}

/**
 * Runs npm only inside a rootless, networkless Node 22 Podman container.
 * Source files and the signed npm cache are read-only mounts; only a dedicated
 * disposable workspace is writable. The resulting workspace is packaged and
 * verified before it becomes a runtime artifact.
 */
export class PodmanNodeBuildRunner {
  private readonly client: PodmanApiClient;
  private readonly options: NodeBuildRunnerOptions;

  constructor(options: NodeBuildRunnerOptions) {
    if (Buffer.byteLength(options.signingKey, "utf8") < 32) {
      throw new Error("Builder cache signing key must contain at least 32 bytes.");
    }
    this.client = new PodmanApiClient(options.transport);
    this.options = options;
  }

  /** Remove builder containers and disposable workspaces left by an agent crash. */
  async reconcile(): Promise<number> {
    const root = path.resolve(this.options.workspaceRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Builder workspace root must be a real directory.");
    }
    const containers = await this.client.listManagedBuilderContainers();
    for (const container of containers) {
      await this.client.removeContainer(container.id);
      const workspace = path.join(root, container.deploymentId);
      const relative = path.relative(root, workspace);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Recovered builder workspace escaped its root.");
      }
      const workspaceStat = await lstat(workspace).catch(() => null);
      if (workspaceStat?.isDirectory() && !workspaceStat.isSymbolicLink()) {
        await rm(workspace, { recursive: true, force: false });
      }
    }
    return containers.length;
  }

  async build(request: NodeBuildRequest): Promise<NodeBuildResult> {
    if (!UUID.test(request.sourceArtifactId) || !UUID.test(request.deploymentId) ||
        request.sourceArtifactId === request.deploymentId) {
      throw new Error("Node build artifact identity is invalid.");
    }
    const source = await readStoredArtifact(this.options.storageRoot, request.sourceArtifactId);
    if (!source || !(await verifyStoredArtifactContents(this.options.storageRoot, request.sourceArtifactId))) {
      throw new Error("Uploaded Node project artifact is missing or failed integrity verification.");
    }
    const sourceDirectory = path.join(path.resolve(this.options.storageRoot), request.sourceArtifactId);
    const metadataPath = path.join(path.resolve(this.options.storageRoot), `${request.sourceArtifactId}.metadata.json`);
    const uploadedPaths = parseArtifactPaths(await readFile(metadataPath, "utf8"));
    const packageJson = await readFile(path.join(sourceDirectory, "package.json"), "utf8");
    const packageLockJson = await readFile(path.join(sourceDirectory, "package-lock.json"), "utf8");
    const lockfileSha256 = createHash("sha256").update(packageLockJson, "utf8").digest("hex");
    const cacheHostPath = path.join(path.resolve(this.options.cacheRoot), lockfileSha256);
    const cacheAttestation = request.cacheAttestation ?? (this.options.allowRegistryEgress
      ? (await provisionNodeBuildCache({
          packageLockJson,
          cacheDirectory: cacheHostPath,
          signingKey: this.options.signingKey,
        })).attestation
      : undefined);
    const planResult = createNodeBuildPlan({
      packageJson,
      packageLockJson,
      uploadedPaths,
      limits: request.limits,
      cacheAttestation,
      cacheSigningKey: this.options.signingKey,
    });
    if (!planResult.valid) throw new Error(planResult.error);
    const plan = planResult.plan;
    if (this.options.builderImage && this.options.builderImage !== BUILDER_IMAGE) {
      throw new Error("Configured Node builder image does not match the approved image.");
    }

    if (!cacheAttestation || cacheAttestation.lockfileSha256 !== lockfileSha256) {
      throw new Error("A verified npm cache for this exact lockfile is required.");
    }
    const cacheStat = await lstat(cacheHostPath).catch(() => null);
    if (!cacheStat?.isDirectory() || cacheStat.isSymbolicLink()) {
      throw new Error("The verified npm cache directory is unavailable.");
    }
    const workspaceHostPath = path.join(path.resolve(this.options.workspaceRoot), request.deploymentId);
    const workspaceParent = path.dirname(workspaceHostPath);
    await mkdir(workspaceParent, { recursive: true, mode: 0o700 });
    const workspaceStat = await lstat(workspaceParent);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error("Builder workspace root must be a real directory.");
    }

    let containerId: string | undefined;
    let output = "";
    let primaryError: unknown;
    try {
      await copyVerifiedTree(sourceDirectory, workspaceHostPath);
      const inputMount = ensureSafeLinuxMount(this.options.containerPath(sourceDirectory));
      const workspaceMount = ensureSafeLinuxMount(this.options.containerPath(workspaceHostPath));
      const cacheMount = ensureSafeLinuxMount(this.options.containerPath(cacheHostPath));
      const config = {
        Image: BUILDER_IMAGE,
        User: plan.user,
        WorkingDir: "/workspace",
        Cmd: ["node", "-e", "setInterval(()=>{},2147483647)"],
        Env: ["HOME=/tmp", "npm_config_update_notifier=false"],
        Labels: {
          "io.dsquare.managed": "builder",
          "io.dsquare.builder": "true",
          "io.dsquare.deployment-id": request.deploymentId,
        },
        HostConfig: {
          Binds: [
            `${inputMount}:/input:ro`,
            `${workspaceMount}:/workspace:rw`,
            `${cacheMount}:/npm-cache:ro`,
          ],
          Memory: plan.memoryBytes,
          NanoCpus: plan.nanoCpus,
          PidsLimit: plan.pidsLimit,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=128m" },
          NetworkMode: "none",
          UsernsMode: "keep-id:uid=10001,gid=10001",
          RestartPolicy: { Name: "no" },
        },
      };
      containerId = await this.client.createContainer(
        config,
        `dsquare-builder-${request.deploymentId}`,
      );
      await this.client.startContainer(containerId);
      const deadline = Date.now() + plan.timeoutMs;
      const versionExec = await this.client.createNodeBuildExec(containerId, "version");
      const versionOutput = await this.client.startAttachedExec(
        versionExec,
        1024,
        Math.min(15 * 60 * 1000, plan.timeoutMs),
      );
      const versionStatus = await this.client.inspectExec(versionExec);
      const actualNpmVersion = versionOutput.toString("utf8").trim();
      if (versionStatus.running || versionStatus.exitCode !== 0 ||
          actualNpmVersion !== cacheAttestation.npmVersion) {
        throw new Error("The isolated builder npm version does not match the signed cache attestation.");
      }
      output = `[version] ${actualNpmVersion}`;
      for (const phase of ["install", "build"] as const) {
        const remaining = deadline - Date.now();
        if (remaining < 1_000) throw new Error("Node build exceeded its total time limit.");
        const execId = await this.client.createNodeBuildExec(containerId, phase);
        const phaseOutput = await this.client.startAttachedExec(
          execId,
          Math.min(plan.maxOutputBytes, 2 * 1024 * 1024),
          Math.min(15 * 60 * 1000, remaining),
        );
        output += `\n[${phase}]\n${phaseOutput.toString("utf8")}`;
        if (Buffer.byteLength(output, "utf8") > plan.maxOutputBytes) {
          throw new Error("Node build output exceeded its configured limit.");
        }
        const status = await this.client.inspectExec(execId);
        if (status.running || status.exitCode !== 0) {
          throw new Error(`Node dependency ${phase} phase failed (exit ${status.exitCode ?? "unknown"}).`);
        }
      }

      // Stop the entire builder container before packaging so background child
      // processes cannot keep mutating the workspace after npm exits.
      await this.client.removeContainer(containerId);
      containerId = undefined;
      const bundle = await createRuntimeArtifactBundle(request.deploymentId, workspaceHostPath);
      const stored = await storeRuntimeArtifact(this.options.storageRoot, request.deploymentId, bundle.bytes);
      return {
        artifactId: stored.artifactId,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        fileCount: stored.fileCount,
        output: output.slice(-64 * 1024),
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (containerId && CONTAINER_ID.test(containerId)) {
        try { await this.client.removeContainer(containerId); }
        catch (error) { cleanupErrors.push(error); }
      }
      await rm(workspaceHostPath, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length && primaryError) {
        throw new AggregateError([primaryError, ...cleanupErrors], "Node build failed and builder cleanup was incomplete.", { cause: primaryError });
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, "Node builder cleanup was incomplete.");
      }
    }
  }
}
