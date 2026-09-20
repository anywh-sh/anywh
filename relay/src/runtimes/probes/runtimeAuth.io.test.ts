import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthNotProbableError, probeRuntimeAuth } from "./runtimeAuth.js";
import type { AgentRuntimeDef, AuthSource, Capabilities, PermissionMode } from "../types.js";

// Boundary tier (.anywh/skills/tests/SKILL.md): a real child process, no
// fake. The "CLI" is a shell script this test writes — the point is proving
// what `probeRuntimeAuth` hands a binary and what it does with what comes
// back, and a script prints to stderr and picks an exit code just as well
// as a 60 MB agent CLI does.

const ALL_NONE: Capabilities = {
  presentChoice: "none",
  approvalPrompt: "none",
  rewindTurn: "none",
  replayHistory: "none",
  backgroundJobs: "none",
  thinking: "none",
  contextUsage: "none",
};

const DEFAULT_MODE: PermissionMode<undefined> = { id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false };

function defWith(bin: string, auth: AuthSource): AgentRuntimeDef {
  return {
    identity: { id: "fixture", bin, env: { strip: ["FIXTURE_API_KEY"] }, projectInstructionsFile: "AGENTS.md" },
    capabilities: ALL_NONE,
    continuity: { kind: "relay-transcript" },
    models: { kind: "static", options: [] },
    auth,
    permissions: { defaultModeId: "default", modesFor: () => [DEFAULT_MODE] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: {
      kind: "spawnPerTurn",
      promptDelivery: "argv",
      buildArgs: () => [],
      mapStdoutLine: () => [],
      interrupt: { signal: "SIGINT", expectsCleanExit: true },
    },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

/** Writes an executable shell script and returns its absolute path —
 * `resolveAgentBin` returns a path with a separator in it untouched, so
 * this is what the probe will actually spawn. */
function fakeCli(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "anywh-auth-probe-")), "fake-cli");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("probeRuntimeAuth: hands the def's args to the def's binary and parses what comes back", async () => {
  const bin = fakeCli('printf "%s\\n" "$*"');
  const def = defWith(bin, {
    kind: "cli-probe",
    args: ["auth", "status", "--json"],
    parse: ({ stdout }) => ({ loggedIn: true, account: stdout.trim() }),
  });
  assert.deepEqual(await probeRuntimeAuth(def, undefined), { loggedIn: true, account: "auth status --json" });
});

test("probeRuntimeAuth: a CLI that answers on stderr and in its exit code is fully readable", async () => {
  // Codex's measured shape: empty stdout, a sentence on stderr, the answer
  // in the code. A probe that only collected stdout would report this
  // logged out.
  const bin = fakeCli('echo "Logged in using ChatGPT" >&2; exit 0');
  const def = defWith(bin, {
    kind: "cli-probe",
    args: [],
    parse: ({ stdout, stderr, exitCode }) => ({ loggedIn: exitCode === 0, account: stdout || undefined, plan: stderr.trim() }),
  });
  assert.deepEqual(await probeRuntimeAuth(def, undefined), { loggedIn: true, account: undefined, plan: "Logged in using ChatGPT" });
});

test("probeRuntimeAuth: the def's stripped credentials never reach the child", async () => {
  // The false positive this whole check exists to prevent: a machine with
  // the provider's API key exported would have the CLI report itself
  // logged in, billing per token instead of drawing on the subscription.
  const bin = fakeCli('printf "%s" "${FIXTURE_API_KEY:-absent}"');
  const def = defWith(bin, { kind: "cli-probe", args: [], parse: ({ stdout }) => ({ loggedIn: true, account: stdout }) });
  process.env.FIXTURE_API_KEY = "sk-should-not-leak";
  try {
    assert.deepEqual(await probeRuntimeAuth(def, undefined), { loggedIn: true, account: "absent" });
  } finally {
    delete process.env.FIXTURE_API_KEY;
  }
});

test("probeRuntimeAuth: homeOverride becomes the child's $HOME — the whole point of validating one", async () => {
  const bin = fakeCli('printf "%s" "$HOME"');
  const def = defWith(bin, { kind: "cli-probe", args: [], parse: ({ stdout }) => ({ loggedIn: true, account: stdout }) });
  const status = await probeRuntimeAuth(def, "/tmp/some-profile-home");
  assert.equal(status.account, "/tmp/some-profile-home");
});

test("probeRuntimeAuth: a parse that throws rejects — an unreadable reply is not a logged-out account", async () => {
  const bin = fakeCli('echo "garbage"');
  const def = defWith(bin, {
    kind: "cli-probe",
    args: [],
    parse: ({ stdout }) => JSON.parse(stdout) as { loggedIn: boolean },
  });
  await assert.rejects(() => probeRuntimeAuth(def, undefined));
});

test("probeRuntimeAuth: a binary that isn't there rejects instead of reporting logged out", async () => {
  const def = defWith("/nonexistent/anywh-fixture-cli", { kind: "cli-probe", args: [], parse: () => ({ loggedIn: true }) });
  await assert.rejects(() => probeRuntimeAuth(def, undefined));
});

test("probeRuntimeAuth: auth.kind none is logged in by the def's own contract, with nothing spawned", async () => {
  const def = defWith("/nonexistent/anywh-fixture-cli", { kind: "none" });
  assert.deepEqual(await probeRuntimeAuth(def, undefined), { loggedIn: true });
});

test("probeRuntimeAuth: auth.kind session-rpc can't be answered outside a session, and says so", async () => {
  const def = defWith("/nonexistent/anywh-fixture-cli", { kind: "session-rpc" });
  await assert.rejects(() => probeRuntimeAuth(def, undefined), AuthNotProbableError);
});
