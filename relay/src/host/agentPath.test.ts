import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShellPath, pickNvmVersion, widenPath } from "./agentPath.js";

test("widenPath: keeps the current PATH first and appends only new absolute dirs", () => {
  assert.equal(widenPath("/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin", "relative/bin", "/opt/homebrew/bin"]), "/usr/bin:/bin:/opt/homebrew/bin");
});

test("widenPath: an empty PATH becomes just the extra dirs", () => {
  assert.equal(widenPath(undefined, ["/a", "/b"]), "/a:/b");
});

test("parseShellPath: reads the PATH between the markers and ignores whatever a profile prints around it", () => {
  const stdout = "Welcome back!\n__ANYWH_PATH__/home/u/.nvm/versions/node/v22.1.0/bin:/usr/bin:not-absolute__ANYWH_PATH__\nbye";
  assert.deepEqual(parseShellPath(stdout), ["/home/u/.nvm/versions/node/v22.1.0/bin", "/usr/bin"]);
});

test("parseShellPath: no markers is no dirs", () => {
  assert.deepEqual(parseShellPath("zsh: command not found: printf"), []);
});

test("pickNvmVersion: the highest version matching the default alias's prefix", () => {
  assert.equal(pickNvmVersion(["v18.20.0", "v20.11.1", "v20.19.0", "v22.1.0"], "20\n"), "v20.19.0");
  assert.equal(pickNvmVersion(["v20.11.1", "v20.19.0"], "v20.11"), "v20.11.1");
});

test("pickNvmVersion: an alias that names no installed version prefix falls back to the highest installed", () => {
  assert.equal(pickNvmVersion(["v18.20.0", "v22.1.0", "v20.19.0"], "lts/*"), "v22.1.0");
  assert.equal(pickNvmVersion(["v18.20.0", "v22.1.0"], undefined), "v22.1.0");
  assert.equal(pickNvmVersion(["v18.20.0"], "21"), "v18.20.0");
});

test("pickNvmVersion: nothing installed is undefined", () => {
  assert.equal(pickNvmVersion([".DS_Store"], "20"), undefined);
});
