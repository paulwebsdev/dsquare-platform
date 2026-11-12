import assert from "node:assert/strict";
import { test } from "node:test";
import { PodmanApiClient, createPodmanSocketTransport, type PodmanRequest, type PodmanResponse } from "./podman-client.js";

test("Podman socket transport requires a Linux absolute socket path", () => {
  assert.throws(() => createPodmanSocketTransport({ socketPath: "tcp://127.0.0.1:9000" }));
  assert.throws(() => createPodmanSocketTransport({ socketPath: "relative.sock" }));
});

test("Podman client creates a named container through the versioned API", async () => {
  const calls: PodmanRequest[] = [];
  const transport = async (request: PodmanRequest): Promise<PodmanResponse> => {
    calls.push(request);
    return {
      statusCode: 201,
      headers: {},
      body: Buffer.from(JSON.stringify({ Id: "a".repeat(64) })),
    };
  };
  const client = new PodmanApiClient(transport);
  const id = await client.createContainer({ Image: "node:22-bookworm-slim" }, "dsquare-site-11111111-1111-4111-8111-111111111111");
  assert.equal(id, "a".repeat(64));
  assert.equal(calls[0]?.method, "POST");
  assert.match(calls[0]?.path ?? "", /^\/v1\.40\/containers\/create\?name=/);
  const builderId = await client.createContainer({}, "dsquare-builder-11111111-1111-4111-8111-111111111111");
  assert.equal(builderId, "a".repeat(64));
  await assert.rejects(() => client.createContainer({}, "untrusted-name"), /container name is invalid/);
});

test("Podman client rejects malformed create responses and propagates API errors", async () => {
  const invalid = new PodmanApiClient(async () => ({
    statusCode: 201, headers: {}, body: Buffer.from('{"Id":"short"}'),
  }));
  await assert.rejects(() => invalid.createContainer({}, "dsquare-site-11111111-1111-4111-8111-111111111111"));

  const failed = new PodmanApiClient(async () => ({
    statusCode: 500, headers: {}, body: Buffer.from('{"message":"socket failure"}'),
  }));
  await assert.rejects(
    () => failed.createContainer({}, "dsquare-site-11111111-1111-4111-8111-111111111111"),
    /socket failure/,
  );
});

test("Podman logs are bounded and tail count is validated", async () => {
  let seenPath = "";
  const client = new PodmanApiClient(async (request) => {
    seenPath = request.path;
    return { statusCode: 200, headers: {}, body: Buffer.from("log output") };
  });
  assert.equal((await client.readContainerLogs("abc123", 50)).toString(), "log output");
  assert.match(seenPath, /tail=50/);
  await assert.rejects(() => client.readContainerLogs("abc123", 5000));
});


test("Podman client lists only validated DSquare-labelled containers", async () => {
  let seenPath = "";
  const client = new PodmanApiClient(async (request) => {
    seenPath = request.path;
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify([
        {
          Id: "a".repeat(64),
          Labels: {
            "io.dsquare.managed": "true",
            "io.dsquare.resource-id": "11111111-1111-4111-8111-111111111111",
            "io.dsquare.deployment-id": "22222222-2222-4222-8222-222222222222",
            "io.dsquare.artifact-id": "22222222-2222-4222-8222-222222222222",
          },
        },
        { Id: "b".repeat(64), Labels: { "io.dsquare.managed": "false" } },
        { Id: "bad", Labels: { "io.dsquare.managed": "true" } },
      ])),
    };
  });
  const managed = await client.listManagedContainers();
  assert.equal(managed.length, 1);
  assert.equal(managed[0]?.id, "a".repeat(64));
  assert.match(seenPath, /containers\/json\?all=true&filters=/);
  assert.match(decodeURIComponent(seenPath), /io.dsquare.managed/);
});


test("Podman client creates only the approved Node builder phases", async () => {
  const calls: PodmanRequest[] = [];
  const client = new PodmanApiClient(async (request) => {
    calls.push(request);
    return { statusCode: 201, headers: {}, body: Buffer.from(JSON.stringify({ Id: "c".repeat(64) })) };
  });
  const install = await client.createNodeBuildExec("a".repeat(64), "install");
  const build = await client.createNodeBuildExec("a".repeat(64), "build");
  assert.equal(install, "c".repeat(64));
  assert.equal(build, "c".repeat(64));
  assert.deepEqual((calls[0]?.body as { Cmd: string[] }).Cmd, [
    "npm", "ci", "--offline", "--cache=/npm-cache", "--logs-dir=/tmp/npm-logs", "--ignore-scripts", "--no-audit", "--no-fund",
  ]);
  assert.deepEqual((calls[1]?.body as { Cmd: string[] }).Cmd, [
    "npm", "run", "build", "--if-present", "--logs-dir=/tmp/npm-logs", "--ignore-scripts",
  ]);
  assert.equal((calls[0]?.body as { User: string }).User, "10001:10001");
  await assert.rejects(() => client.createNodeBuildExec("short", "install"));
});

test("Podman client starts detached builder exec and inspects completion", async () => {
  const calls: PodmanRequest[] = [];
  const client = new PodmanApiClient(async (request) => {
    calls.push(request);
    if (request.path.endsWith("/start")) {
      return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
    }
    return {
      statusCode: 200, headers: {},
      body: Buffer.from(JSON.stringify({ Running: false, ExitCode: 0 })),
    };
  });
  await client.startDetachedExec("d".repeat(64));
  const status = await client.inspectExec("d".repeat(64));
  assert.deepEqual(status, { running: false, exitCode: 0 });
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { Detach: true, Tty: false });
  assert.match(calls[1]?.path ?? "", /exec\/.+\/json$/);
});

test("Podman client rejects malformed builder exec status", async () => {
  const client = new PodmanApiClient(async () => ({
    statusCode: 200, headers: {}, body: Buffer.from('{"Running":"false","ExitCode":"0"}'),
  }));
  await assert.rejects(() => client.inspectExec("e".repeat(64)), /invalid builder exec status/);
});


test("Podman client creates an in-container HTTP readiness probe without a shell", async () => {
  let seen: PodmanRequest | undefined;
  const client = new PodmanApiClient(async (request) => {
    seen = request;
    return {
      statusCode: 201,
      headers: {},
      body: Buffer.from(JSON.stringify({ Id: "f".repeat(64) })),
    };
  });
  const id = await client.createRuntimeReadinessExec("a".repeat(64));
  assert.equal(id, "f".repeat(64));
  assert.equal(seen?.method, "POST");
  assert.match(seen?.path ?? "", /containers\/a{64}\/exec$/);
  const body = seen?.body as { Cmd: string[]; User: string; WorkingDir: string };
  assert.equal(body.Cmd[0], "node");
  assert.equal(body.Cmd[1], "-e");
  assert.equal(body.User, "10001:10001");
  assert.equal(body.WorkingDir, "/app");
  assert.doesNotMatch(body.Cmd.join(" "), /sh -c|bash/);
});


test("Podman client captures bounded multiplexed builder output", async () => {
  const payload = Buffer.from("build completed");
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = 1;
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 8);
  const client = new PodmanApiClient(async (request) => {
    assert.equal(request.method, "POST");
    assert.match(request.path, /exec\\/.+\\/start$/);
    assert.deepEqual(request.body, { Detach: false, Tty: false });
    return { statusCode: 200, headers: { "content-type": "application/vnd.docker.raw-stream" }, body: frame };
  });
  assert.equal((await client.startAttachedExec("a".repeat(64))).toString(), "build completed");
});

test("Podman client rejects malformed or oversized attached builder output", async () => {
  const malformed = new PodmanApiClient(async () => ({
    statusCode: 200, headers: {}, body: Buffer.from([1, 0, 0]),
  }));
  await assert.rejects(() => malformed.startAttachedExec("a".repeat(64)), /truncated builder output/);
  const oversized = new PodmanApiClient(async () => ({
    statusCode: 200, headers: {}, body: Buffer.alloc(9),
  }));
  await assert.rejects(() => oversized.startAttachedExec("a".repeat(64), 8), /exceeded its permitted limit/);
});


test("Podman client lists only builder-labelled containers with valid deployment IDs", async () => {
  const client = new PodmanApiClient(async (request) => {
    assert.match(decodeURIComponent(request.path), /io.dsquare.builder/);
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify([
        { Id: "a".repeat(64), Labels: {
          "io.dsquare.builder": "true",
          "io.dsquare.deployment-id": "11111111-1111-4111-8111-111111111111",
        } },
        { Id: "b".repeat(64), Labels: {
          "io.dsquare.builder": "false",
          "io.dsquare.deployment-id": "22222222-2222-4222-8222-222222222222",
        } },
        { Id: "bad", Labels: {
          "io.dsquare.builder": "true",
          "io.dsquare.deployment-id": "not-a-uuid",
        } },
      ])),
    };
  });
  assert.deepEqual(await client.listManagedBuilderContainers(), [{
    id: "a".repeat(64),
    deploymentId: "11111111-1111-4111-8111-111111111111",
  }]);
});
