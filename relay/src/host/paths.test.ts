import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCwd, resolveShipped } from "./paths.js";

test("defaultCwd falls back to the real home directory", () => {
  assert.equal(defaultCwd(undefined), homedir());
  assert.equal(defaultCwd("/custom/home"), "/custom/home");
});

test("resolveShipped resolves relative to the calling file outside a SEA build", () => {
  // Every real caller (the test process itself, `tsx` in dev, the Linux
  // tarball's `dist/`) hits this branch — `isSea()` is only ever true
  // inside the macOS SEA binary this module also supports, which nothing
  // in this test suite runs as.
  const here = import.meta.url;
  assert.equal(resolveShipped(here, "../../scripts", "scripts"), resolve(dirname(fileURLToPath(here)), "../../scripts"));
});
