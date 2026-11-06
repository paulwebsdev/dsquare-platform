import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWebsiteFilePath } from "./website-file-path.js";

test("accepts safe nested website paths", () => {
  assert.equal(normalizeWebsiteFilePath("assets/logo.svg"), "assets/logo.svg");
  assert.equal(normalizeWebsiteFilePath("css/site.css"), "css/site.css");
  assert.equal(normalizeWebsiteFilePath("js/app.js"), "js/app.js");
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
