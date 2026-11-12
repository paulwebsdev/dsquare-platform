import assert from "node:assert/strict";
import test from "node:test";
import { validateNodeProject } from "./node-project-validation.js";

function validationError(result: ReturnType<typeof validateNodeProject>): string {
  assert.equal(result.valid, false, "Expected Node project validation to fail");
  if (result.valid) throw new Error("Expected Node project validation to fail");
  return result.error;
}

const validManifest = JSON.stringify({
  name: "sample-backend",
  main: "server.js",
  scripts: { start: "node server.js" },
  engines: { node: "22.x" },
});

test("accepts a Node 22 project with package.json and its entrypoint", () => {
  assert.deepEqual(
    validateNodeProject(validManifest, ["package.json", "package-lock.json", "server.js"]),
    { valid: true, entrypoint: "server.js", startCommand: "npm start", nodeMajor: 22 },
  );
});

test("requires a valid package.json and start script", () => {
  assert.match(validationError(validateNodeProject("{", ["package.json", "server.js"])), /invalid JSON/);
  assert.match(
    validationError(validateNodeProject(JSON.stringify({ main: "server.js" }), ["package.json", "package-lock.json", "server.js"])),
    /scripts.start/,
  );
});

test("rejects unsupported Node engine ranges", () => {
  const manifest = JSON.stringify({
    main: "server.js",
    scripts: { start: "node server.js" },
    engines: { node: ">=20" },
  });
  assert.match(validationError(validateNodeProject(manifest, ["package.json", "package-lock.json", "server.js"])), /Node.js 22/);
});

test("rejects unsafe or missing entrypoints", () => {
  for (const main of ["../server.js", "/tmp/server.js", "server.ts", "nested/../server.js"]) {
    const manifest = JSON.stringify({ main, scripts: { start: "node server.js" } });
    assert.equal(validateNodeProject(manifest, ["package.json", "package-lock.json", "server.js"]).valid, false);
  }
  assert.match(
    validationError(validateNodeProject(validManifest, ["package.json", "package-lock.json"])),
    /Upload the configured Node.js entrypoint/,
  );
});

test("requires package.json at the project root", () => {
  assert.match(
    validationError(validateNodeProject(validManifest, ["app/package.json", "server.js"])),
    /package.json at the website root/,
  );
});


test("requires a root npm lockfile before an isolated dependency build", () => {
  assert.match(
    validationError(validateNodeProject(validManifest, ["package.json", "server.js"])),
    /package-lock.json at the website root/,
  );
});
