import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWebsiteFilePath, normalizeWebsiteRequestPath } from "./website-file-path.js";

test("accepts safe nested website paths", () => {
  assert.equal(normalizeWebsiteFilePath("assets/logo.svg"), "assets/logo.svg");
  assert.equal(normalizeWebsiteFilePath("css/site.css"), "css/site.css");
  assert.equal(normalizeWebsiteFilePath("js/app.js"), "js/app.js");
  assert.equal(normalizeWebsiteFilePath("server.cjs"), "server.cjs");
  assert.equal(normalizeWebsiteFilePath("index.html"), "index.html");
});

test("rejects unsafe website paths", () => {
  const invalid = [
    "." + "/secret.txt",
    "assets/" + ".." + "/secret.txt",
    "/etc/passwd.txt",
    "assets//logo.svg",
    "assets/./logo.svg",
    "assets" + String.fromCharCode(92) + "logo.svg",
    "C:/secret.txt",
    "assets/",
    "assets/logo.exe",
    "bad" + String.fromCharCode(0) + "name.svg",
  ];
  for (const value of invalid) {
    assert.equal(normalizeWebsiteFilePath(value), null);
  }
});

test("accepts safe extensionless paths for frontend SPA routes", () => {
  assert.equal(normalizeWebsiteRequestPath("dashboard"), "dashboard");
  assert.equal(normalizeWebsiteRequestPath("account/profile"), "account/profile");
});

test("rejects unsafe extensionless website routes", () => {
  const invalid = [
    "../dashboard",
    "/dashboard",
    "account//profile",
    "account" + String.fromCharCode(92) + "profile",
    "account/" + String.fromCharCode(0) + "profile",
  ];
  for (const value of invalid) {
    assert.equal(normalizeWebsiteRequestPath(value), null);
  }
});
