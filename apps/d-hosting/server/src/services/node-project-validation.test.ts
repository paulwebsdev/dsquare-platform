import assert from "node:assert/strict";
import test from "node:test";
import { validateNodeProject } from "./node-project-validation.js";

const validManifest = JSON.stringify({
  name: "sample-backend",
  main: "server.js",
  scripts: { start: "node server.js" },
  engines: { node: "22.x" },
});

test("accepts a Node 22 project with package.json and its entrypoint", () => {
  assert.deepEqual(
    validateNodeProject(validManifest, ["package.json", "server.js"]),
    { valid: true, entrypoint: "server.js", startCommand: "npm start", nodeMajor: 22 },
  );
});

test("requires a valid package.json and start script", () => {
  assert.match(validateNodeProject("{", ["package.json", "server.js"]).error ?? "", /invalid JSON/);
  assert.match(
    validateNodeProject(JSON.stringify({ main: "server.js" }), ["package.json", "server.js"]).error ?? "",
    /scripts.start/,
  );
});

test("rejects unsupported Node engine ranges", () => {
  const manifest = JSON.stringify({
    main: "server.js",
    scripts: { start: "node server.js" },
    engines: { node: ">=20" },
  });
  assert.match(validateNodeProject(manifest, ["package.json", "server.js"]).error ?? "", /Node.js 22/);
});

test("rejects unsafe or missing entrypoints", () => {
  for (const main of ["../server.js", "/tmp/server.js", "server.ts", "nested/../server.js"]) {
    const manifest = JSON.stringify({ main, scripts: { start: "node server.js" } });
    assert.equal(validateNodeProject(manifest, ["package.json", "server.js"]).valid, false);
  }
  assert.match(
    validateNodeProject(validManifest, ["package.json"]).error ?? "",
    /Upload the configured Node.js entrypoint/,
  );
});

test("requires package.json at the project root", () => {
  assert.match(
    validateNodeProject(validManifest, ["app/package.json", "server.js"]).error ?? "",
    /package.json at the website root/,
  );
});
