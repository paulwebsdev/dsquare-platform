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
