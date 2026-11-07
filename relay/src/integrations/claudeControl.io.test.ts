// The Claude control process against a real child: tests/fixtures/
// fake-claude.mjs, answering `initialize` and `mcp_status` with the shapes
// recorded from Claude Code 2.1.303. Proves the wiring (spawn, env,
// request ids, timeouts, the pool), never Claude's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { ClaudeControlError, ClaudeControlPool, ClaudeControlTimeout, claudeControlArgs, startClaudeControl } from "./claudeControl.js";
import { CLAUDE_MCP_STATUS_SETTLED } from "./inventory/fixtures.js";

const FAKE_CLAUDE = resolve(import.meta.dirname, "../../tests/fixtures/fake-claude.mjs");

function setup(t: { after: (fn: () => void) => void }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-claude-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusFile = join(dir, "status.json");
  writeFileSync(statusFile, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  const invocationsFile = join(dir, "invocations.jsonl");
  const def: AgentRuntimeDef = {
    ...claudeRuntimeDef,
    identity: {
      ...claudeRuntimeDef.identity,
      bin: FAKE_CLAUDE,
      env: { ...claudeRuntimeDef.identity.env, set: { ...claudeRuntimeDef.identity.env.set, FAKE_CLAUDE_MCP_STATUS_FILE: statusFile, FAKE_CLAUDE_INVOCATIONS_FILE: invocationsFile, ...env } },
    },
  };
  const invocations = (): { args: string[]; cwd: string; home: string; billedCredentials: string[] }[] => {
    try {
      return readFileSync(invocationsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string; billedCredentials: string[] });
    } catch {
      return [];
    }
  };
  const args = claudeControlArgs(def);
  assert.ok(args);
  return { dir, def, args, invocations };
}

const waitFor = async (condition: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("mcp_status: answered by request id, concurrent requests each get their own reply, in the profile's home", async (t) => {
  const { dir, def, args, invocations } = setup(t);
  const home = join(dir, "home");
  const control = startClaudeControl({ def, args, cwd: dir, homeOverride: home });
  t.after(() => control.close());
  const [first, second] = await Promise.all([control.request("mcp_status"), control.request("mcp_status")]);
  assert.deepEqual(first, CLAUDE_MCP_STATUS_SETTLED);
  assert.deepEqual(second, CLAUDE_MCP_STATUS_SETTLED);
  const [invocation] = invocations();
  assert.deepEqual(invocation.args, [...args]);
  assert.equal(invocation.home, home);
  assert.equal(invocation.cwd, dir);
  assert.deepEqual(invocation.billedCredentials, []);
});

test("a request the CLI does not know is rejected with its own error text, and the process stays usable", async (t) => {
  const { dir, def, args } = setup(t);
  const control = startClaudeControl({ def, args, cwd: dir });
  t.after(() => control.close());
  await assert.rejects(control.request("no_such_thing"), (error: unknown) => error instanceof ClaudeControlError && error.message === "Unsupported control request subtype: no_such_thing");
  assert.equal(control.exited, false);
  assert.ok(await control.request("mcp_status"));
});

test("no answer in time: rejected with a timeout, and the wedged process is stopped", async (t) => {
  const { dir, def, args } = setup(t, { FAKE_CLAUDE_MCP_STATUS_HANG: "1" });
  const control = startClaudeControl({ def, args, cwd: dir });
  t.after(() => control.close());
  await assert.rejects(control.request("mcp_status", {}, 200), ClaudeControlTimeout);
  assert.equal(control.exited, true);
  await assert.rejects(control.request("mcp_status"), /exited/);
});

test("a binary that does not exist: every request is rejected, nothing throws", async (t) => {
  const { dir, def, args } = setup(t);
  const missing = { ...def, identity: { ...def.identity, bin: join(dir, "no-such-claude") } };
  const control = startClaudeControl({ def: missing, args, cwd: dir });
  await assert.rejects(control.request("mcp_status"), /exited/);
  assert.equal(control.exited, true);
});

test("pool: one process per folder, reused; `fresh` replaces it; the least recent project folder is stopped first", async (t) => {
  const { dir, def, invocations } = setup(t);
  const pool = new ClaudeControlPool({ def, neutralCwd: dir, maxProjectProcesses: 1 });
  t.after(() => pool.close());
  const projectA = mkdtempSync(join(dir, "a-"));
  const projectB = mkdtempSync(join(dir, "b-"));
  await pool.request(undefined, "mcp_status");
  await pool.request(undefined, "mcp_status");
  assert.equal(invocations().length, 1);
  await pool.request(undefined, "mcp_status", {}, { fresh: true });
  assert.equal(invocations().length, 2);
  await pool.request(projectA, "mcp_status");
  await pool.request(projectB, "mcp_status");
  assert.deepEqual(pool.running().sort(), [dir, projectB].sort());
  assert.deepEqual(
    invocations().map((invocation) => invocation.cwd),
    [dir, dir, projectA, projectB],
  );
});

test("pool: a process with no request for `idleMs` is stopped; the next request starts another", async (t) => {
  const { dir, def, invocations } = setup(t);
  const pool = new ClaudeControlPool({ def, neutralCwd: dir, idleMs: 150 });
  t.after(() => pool.close());
  await pool.request(undefined, "mcp_status");
  await waitFor(() => pool.running().length === 0);
  await pool.request(undefined, "mcp_status");
  assert.equal(invocations().length, 2);
});

test("pool: a request slower than `idleMs` is not cut by the idle stop, which counts from its answer", async (t) => {
  const { dir, def, invocations } = setup(t, { FAKE_CLAUDE_MCP_CALL_DELAY_MS: "300" });
  const pool = new ClaudeControlPool({ def, neutralCwd: dir, idleMs: 50 });
  t.after(() => pool.close());
  const reply = (await pool.request(undefined, "mcp_call", { tool: "mcp__sentry__whoami", arguments: {} })) as { content: { text: string }[] };
  assert.match(reply.content[0].text, /"tool":"whoami"/);
  assert.deepEqual(pool.running(), [dir], "the answer re-arms the idle clock instead of finding it run out");
  await waitFor(() => pool.running().length === 0);
  assert.equal(invocations().length, 1);
});

test("pool: a fresh scan or a recycle lets the replaced process answer what it was asked before it ends", async (t) => {
  const { dir, def, invocations } = setup(t, { FAKE_CLAUDE_MCP_CALL_DELAY_MS: "400" });
  const pool = new ClaudeControlPool({ def, neutralCwd: dir });
  t.after(() => pool.close());
  const call = () => pool.request(undefined, "mcp_call", { tool: "mcp__sentry__whoami", arguments: {} }) as Promise<{ content: { text: string }[] }>;

  const slow = call();
  // Started, not just pooled: under load the first process may record
  // itself after the replacement does.
  await waitFor(() => invocations().length === 1);
  await pool.request(undefined, "mcp_status", {}, { fresh: true });
  assert.equal(invocations().length, 2, "the scan ran on a new process");
  assert.match((await slow).content[0].text, /"tool":"whoami"/);

  const again = call();
  await new Promise((r) => setTimeout(r, 100));
  pool.recycle();
  assert.deepEqual(pool.running(), []);
  assert.match((await again).content[0].text, /"tool":"whoami"/);
  await pool.request(undefined, "mcp_status");
  assert.equal(invocations().length, 3);
});
