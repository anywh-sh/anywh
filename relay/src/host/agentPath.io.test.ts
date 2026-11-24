import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PATH_DISCOVERY_ENV, discoverAgentPath, readLoginShellPath } from "./agentPath.js";

async function withHome(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "anywh-agent-path-test-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const NO_SHELL = { loginShell: false, nodeDir: null } as const;

test("discoverAgentPath: keeps only dirs that exist, including npm's own prefix from ~/.npmrc", async () => {
  await withHome((home) => {
    mkdirSync(join(home, ".npm-packages", "bin"), { recursive: true });
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    writeFileSync(join(home, ".npmrc"), "fund=false\nprefix=~/.npm-packages\n");
    const added = discoverAgentPath({ PATH: "/usr/bin" }, { ...NO_SHELL, home, platform: "linux" });
    assert.ok(added.includes(join(home, ".npm-packages", "bin")));
    assert.ok(added.includes(join(home, ".bun", "bin")));
    assert.ok(!added.includes(join(home, ".volta", "bin")), "a dir that doesn't exist is never added");
  });
});

test("discoverAgentPath: the opt-out and Windows add nothing", async () => {
  await withHome((home) => {
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    assert.deepEqual(discoverAgentPath({ PATH: "/usr/bin", [AGENT_PATH_DISCOVERY_ENV]: "0" }, { ...NO_SHELL, home }), []);
    assert.deepEqual(discoverAgentPath({ PATH: "/usr/bin" }, { ...NO_SHELL, home, platform: "win32" }), []);
  });
});

test("readLoginShellPath: reads the PATH an interactive login shell builds, banner and all", async () => {
  await withHome((home) => {
    const extra = join(home, "tools", "bin");
    writeFileSync(join(home, ".bash_profile"), `echo "hello from the profile"\nexport PATH="${extra}:$PATH"\n`);
    const dirs = readLoginShellPath({ HOME: home, PATH: "/usr/bin:/bin" }, "/bin/bash");
    assert.equal(dirs[0], extra);
    assert.ok(dirs.includes("/usr/bin"));
  });
});

test("readLoginShellPath: a shell that hangs costs the timeout and adds nothing", async () => {
  await withHome((home) => {
    const shell = join(home, "slow-shell");
    executable(shell, "#!/bin/sh\nsleep 10\n");
    const started = Date.now();
    assert.deepEqual(readLoginShellPath({ HOME: home, PATH: "/usr/bin:/bin" }, shell, 300), []);
    assert.ok(Date.now() - started < 5000);
  });
});

test("readLoginShellPath: a shell that doesn't exist adds nothing", () => {
  assert.deepEqual(readLoginShellPath({ PATH: "/usr/bin" }, "/nonexistent/shell"), []);
});
