import test from "node:test";
import assert from "node:assert/strict";
import { detectWebsiteRoot } from "./website-root.js";

test("prefers an index.html at the website root", () => {
  assert.deepEqual(
    detectWebsiteRoot(["index.html", "assets/logo.svg", "nested/index.html"]),
    { rootPath: "", homepagePath: "index.html" }
  );
});

test("detects a single uploaded folder as the website root", () => {
  assert.deepEqual(
    detectWebsiteRoot([
      "my-site/index.html",
      "my-site/css/site.css",
      "my-site/assets/logo.svg",
    ]),
    { rootPath: "my-site/", homepagePath: "my-site/index.html" }
  );
});

test("chooses the shallowest homepage when nested pages also contain index files", () => {
  assert.deepEqual(
    detectWebsiteRoot([
      "dist/index.html",
      "dist/admin/index.html",
      "dist/assets/app.js",
    ]),
    { rootPath: "dist/", homepagePath: "dist/index.html" }
  );
});

test("does not guess when multiple independent website roots are present", () => {
  assert.equal(
    detectWebsiteRoot(["site-a/index.html", "site-b/index.html"]),
    null
  );
});

test("returns null when no supported homepage exists", () => {
  assert.equal(detectWebsiteRoot(["assets/logo.svg", "css/site.css"]), null);
});
