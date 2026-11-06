import test from "node:test";
import assert from "node:assert/strict";
import { getWebsiteFileCandidates } from "./website-file-resolution.js";

const uploaded = [
  "release/index.html",
  "release/assets/app.js",
  "release/assets/site.css",
];

test("keeps an exact requested file as the first candidate", () => {
  assert.deepEqual(
    getWebsiteFileCandidates("assets/app.js", uploaded),
    ["assets/app.js", "release/assets/app.js"]
  );
});

test("maps the homepage request to the detected uploaded folder", () => {
  assert.deepEqual(
    getWebsiteFileCandidates("index.html", uploaded),
    ["index.html", "release/index.html"]
  );
});

test("falls back to the homepage for missing extensionless SPA routes", () => {
  assert.deepEqual(
    getWebsiteFileCandidates("account/settings", uploaded),
    ["account/settings", "release/account/settings", "release/index.html"]
  );
});

test("does not fall back to the homepage for missing static assets", () => {
  assert.deepEqual(
    getWebsiteFileCandidates("assets/missing.js", uploaded),
    ["assets/missing.js", "release/assets/missing.js"]
  );
});

test("rejects unsafe request paths", () => {
  assert.deepEqual(getWebsiteFileCandidates("../secret", uploaded), []);
});

test("does not guess a root when uploaded folders are ambiguous", () => {
  assert.deepEqual(
    getWebsiteFileCandidates("dashboard", [
      "first/index.html",
      "second/index.html",
    ]),
    ["dashboard"]
  );
});
