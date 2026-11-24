import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAgentHostSocketPath } from "./paths.js";
import { isValidProfileId } from "../host/profileRegistry.js";

// What `os.tmpdir()` returns for a real user on macOS.
const MACOS_TMPDIR = "/var/folders/7x/k2xq9w3n5vb1hd0r8mzl4c6t0000gn/T";
// macOS's sun_path is 104 bytes, the terminating NUL included.
const MACOS_SUN_PATH_MAX = 103;

test("a 32-character profile's socket fits macOS's socket path limit", () => {
  const profile = "a".repeat(32);
  assert.ok(isValidProfileId(profile), "32 characters is the longest id the registry allows");
  const socketPath = defaultAgentHostSocketPath(profile, {}, "darwin", MACOS_TMPDIR);
  assert.ok(
    Buffer.byteLength(socketPath) <= MACOS_SUN_PATH_MAX,
    `${socketPath} is ${Buffer.byteLength(socketPath)} bytes`,
  );
});

test("Linux keeps the descriptive socket name", () => {
  assert.equal(
    defaultAgentHostSocketPath("pessoal", { XDG_RUNTIME_DIR: "/run/user/1000" }, "linux"),
    "/run/user/1000/anywh/agent-host-pessoal.sock",
  );
});
