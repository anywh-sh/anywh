import { test } from "node:test";
import assert from "node:assert/strict";
import { toHostPlatform } from "./hostPlatform.js";

test("toHostPlatform passes through every HostPlatform value unchanged", () => {
  for (const platform of ["darwin", "freebsd", "linux", "openbsd", "sunos", "win32"] as const) {
    assert.equal(toHostPlatform(platform), platform);
  }
});

test("toHostPlatform narrows an unlisted NodeJS.Platform (e.g. 'aix') to 'linux'", () => {
  assert.equal(toHostPlatform("aix"), "linux");
});
