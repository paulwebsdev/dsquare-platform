import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPodmanContainerConfig } from "./podman-runtime-config.js";

const resourceId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const artifactId = deploymentId;
const runtime = {
  name: `dsquare-site-${resourceId}`,
  image: "node:22-bookworm-slim",
  workingDirectory: "/app" as const,
  command: ["npm", "start"] as ["npm", "start"],
  environment: { PORT: "3000", NODE_ENV: "production" },
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pidsLimit: 128,
  user: "10001:10001" as const,
  readOnlyRootFilesystem: true as const,
  capDrop: ["ALL"] as ["ALL"],
  securityOpt: ["no-new-privileges:true"] as ["no-new-privileges:true"],
  tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" as const },
};

test("builds a restricted Podman config without publishing a host port", () => {
  const config = buildPodmanContainerConfig({
    resourceId, deploymentId, artifactId, runtime, artifactDirectory: "/srv/dsquare/artifacts/site-1",
    trustedImage: "node:22-bookworm-slim", networkName: "dsquare-hosting-internal",
  }) as { HostConfig: Record<string, unknown>; ExposedPorts: Record<string, unknown> };
  assert.deepEqual(config.HostConfig.Binds, ["/srv/dsquare/artifacts/site-1:/app:ro"]);
  assert.equal(config.HostConfig.Memory, runtime.memoryBytes);
  assert.equal(config.HostConfig.NanoCpus, runtime.nanoCpus);
  assert.equal(config.HostConfig.PidsLimit, runtime.pidsLimit);
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(config.HostConfig.CapDrop, ["ALL"]);
  assert.equal(config.HostConfig.NetworkMode, "dsquare-hosting-internal");
  assert.deepEqual(config.ExposedPorts, { "3000/tcp": {} });
  assert.deepEqual((config as { Labels: Record<string, string> }).Labels, {
    "io.dsquare.managed": "true",
    "io.dsquare.resource-id": resourceId,
    "io.dsquare.deployment-id": deploymentId,
    "io.dsquare.artifact-id": artifactId,
  });
  assert.equal("PortBindings" in config.HostConfig, false);
});

test("rejects unapproved images and unsafe mounts", () => {
  assert.throws(() => buildPodmanContainerConfig({
    resourceId, deploymentId, artifactId, runtime: { ...runtime, image: "attacker/image:latest" },
    artifactDirectory: "/srv/artifacts/site", trustedImage: "node:22-bookworm-slim",
    networkName: "dsquare-hosting-internal",
  }), /pre-approved image/);
  assert.throws(() => buildPodmanContainerConfig({
    resourceId, deploymentId, artifactId, runtime, artifactDirectory: "/srv/artifacts/site:rw",
    trustedImage: runtime.image, networkName: "dsquare-hosting-internal",
  }), /safe Linux absolute path/);
});

test("rejects weakened isolation and invalid resource limits", () => {
  assert.throws(() => buildPodmanContainerConfig({
    resourceId, deploymentId, artifactId, runtime: { ...runtime, readOnlyRootFilesystem: false as true },
    artifactDirectory: "/srv/artifacts/site", trustedImage: runtime.image,
    networkName: "dsquare-hosting-internal",
  }), /isolation contract/);
  assert.throws(() => buildPodmanContainerConfig({
    resourceId, deploymentId, artifactId, runtime: { ...runtime, pidsLimit: 2 },
    artifactDirectory: "/srv/artifacts/site", trustedImage: runtime.image,
    networkName: "dsquare-hosting-internal",
  }), /resource limits/);
});
