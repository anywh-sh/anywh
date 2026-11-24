import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentPath, widenPath } from "../host/agentPath.js";
import { detectRuntime, detectRuntimes } from "./detection.js";
import type { AgentRuntimeDef, Capabilities } from "./types.js";

const ALL_NONE: Capabilities = {
  presentChoice: "none",
  approvalPrompt: "none",
  rewindTurn: "none",
  replayHistory: "none",
  backgroundJobs: "none",
  thinking: "none",
  contextUsage: "none",
};

// Awaits `run` before cleaning up — unlike wakeupScheduler.io.test.ts's
// synchronous version of this helper, every caller here does async work
// (detectRuntime spawns a real child process), and deleting the tmpdir
// before that settles was a real bug caught writing this file: node:test
// reported "asynchronous activity after the test ended" because the
// directory (and the script in it) disappeared out from under a still-running spawn.
async function withTmpDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-detection-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a real, executable Node script — not a mock of any agent CLI's
 * protocol, just something `detectRuntime` can genuinely spawn and check
 * the exit code / stdout of. `body` runs with `--version` as `argv[2]`. */
function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixtureDef(overrides: Partial<AgentRuntimeDef["identity"]> = {}): AgentRuntimeDef {
  return {
    identity: { id: "fixture", bin: "fixture-cli", env: { strip: [] }, projectInstructionsFile: "AGENTS.md", ...overrides },
    capabilities: ALL_NONE,
    continuity: { kind: "relay-transcript" },
    models: { kind: "static", catalog: { options: [] } },
    auth: { kind: "none" },
    permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false }] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: { kind: "spawnPerTurn", promptDelivery: "argv", buildArgs: () => [], mapStdoutLine: () => [], interrupt: { signal: "SIGINT", expectsCleanExit: true } },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

test("detectRuntime: an installed binary reports version and passes capabilities through", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeScript(dir, "fake-agent", 'process.stdout.write("v1.2.3");\nprocess.exit(0);');
    const detection = await detectRuntime(fixtureDef({ bin }));
    assert.deepEqual(detection, { id: "fixture", installed: true, version: "v1.2.3", capabilities: ALL_NONE });
  });
});

test("detectRuntime: a missing binary resolves installed:false instead of rejecting", async () => {
  const detection = await detectRuntime(fixtureDef({ bin: "definitely-not-a-real-binary-xyz-anywh" }));
  assert.deepEqual(detection, { id: "fixture", installed: false, capabilities: ALL_NONE });
});

test("detectRuntime: a binary that exits non-zero on --version is reported as not installed", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeScript(dir, "broken-agent", "process.exit(1);");
    const detection = await detectRuntime(fixtureDef({ bin }));
    assert.deepEqual(detection, { id: "fixture", installed: false, capabilities: ALL_NONE });
  });
});

test("detectRuntime: strips the def's own env.strip vars before spawning", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeScript(dir, "credential-checking-agent", 'process.stdout.write(process.env.FIXTURE_API_KEY ? "leaked" : "clean");\nprocess.exit(0);');
    const def = fixtureDef({ bin, env: { strip: ["FIXTURE_API_KEY"] } });
    process.env.FIXTURE_API_KEY = "should-never-reach-the-child";
    try {
      const detection = await detectRuntime(def);
      assert.equal(detection.version, "clean");
    } finally {
      delete process.env.FIXTURE_API_KEY;
    }
  });
});

test("detectRuntimes: one broken def doesn't prevent the other from resolving", async () => {
  await withTmpDir(async (dir) => {
    const workingBin = writeScript(dir, "working-agent", 'process.stdout.write("v9");\nprocess.exit(0);');
    const results = await detectRuntimes([fixtureDef({ id: "broken", bin: "definitely-not-a-real-binary-xyz-anywh" }), fixtureDef({ id: "working", bin: workingBin })]);
    assert.deepEqual(
      [...results].sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "broken", installed: false, capabilities: ALL_NONE },
        { id: "working", installed: true, version: "v9", capabilities: ALL_NONE },
      ],
    );
  });
});

// The real failure: a relay under launchd (no `node` on PATH) and an agent CLI
// installed with `npm i -g` under nvm — a `#!/usr/bin/env node` script whose
// `node` sits next to it. Detection said "not installed" until the PATH was
// widened.
test("an npm-installed CLI under nvm is detected once the PATH is widened, and not before", async () => {
  await withTmpDir(async (home) => {
    const bin = join(home, ".nvm", "versions", "node", "v22.1.0", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "anywh-fixture-agent"), '#!/usr/bin/env node\nconsole.log("1.2.3 (Fixture)")\n');
    chmodSync(join(bin, "anywh-fixture-agent"), 0o755);
    const empty = join(home, "empty");
    mkdirSync(empty);

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = empty;
      assert.equal((await detectRuntime(fixtureDef({ bin: "anywh-fixture-agent" }))).installed, false);

      // A clean env, not process.env: an NVM_DIR exported by the shell that
      // runs the tests would aim discovery at that machine's real nvm.
      const added = discoverAgentPath({ PATH: empty }, { loginShell: false, nodeDir: null, home, platform: "darwin" });
      assert.ok(added.includes(bin), `expected ${bin} in ${added.join(":")}`);
      process.env.PATH = widenPath(empty, added);
      assert.equal(process.env.PATH.split(":")[0], empty, "the relay's own PATH stays first");
      const detection = await detectRuntime(fixtureDef({ bin: "anywh-fixture-agent" }));
      assert.equal(detection.installed, true);
      assert.equal(detection.version, "1.2.3 (Fixture)");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
