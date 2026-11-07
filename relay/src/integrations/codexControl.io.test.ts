// The Codex control daemon against a real child speaking real JSON-RPC:
// tests/fixtures/fake-codex-app-server.mjs (codex-cli 0.154.0 shapes).
// Proves the wiring (one thread reused, recreated when lost, timeouts),
// never Codex's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { CodexControlTimeout, createCodexControl } from "./codexControl.js";
import { CODEX_MCP_STATUS_LIST } from "./inventory/fixtures.js";
import { spawnCodexDaemon } from "../runtimes/transports/codexDaemon.js";

const FAKE_CODEX = resolve(import.meta.dirname, "../../tests/fixtures/fake-codex-app-server.mjs");

function setup(t: { after: (fn: () => void) => void }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codex-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusFile = join(dir, "status.json");
  writeFileSync(statusFile, JSON.stringify(CODEX_MCP_STATUS_LIST));
  const requestsFile = join(dir, "requests.jsonl");
  const forgetFile = join(dir, "forget");
  const def: AgentRuntimeDef = {
    ...codexRuntimeDef,
    identity: {
      ...codexRuntimeDef.identity,
      bin: FAKE_CODEX,
      env: { ...codexRuntimeDef.identity.env, set: { FAKE_CODEX_MCP_STATUS_FILE: statusFile, FAKE_CODEX_REQUESTS: requestsFile, FAKE_CODEX_FORGET_THREADS_FILE: forgetFile, ...env } },
    },
  };
  const requests = (): { method: string; params?: unknown }[] => {
    try {
      return readFileSync(requestsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params?: unknown });
    } catch {
      return [];
    }
  };
  const methods = (): string[] => requests().map((request) => request.method);
  return { dir, def, methods, requests, forgetFile };
}

const listStatus = (threadId: string) => ({ detail: "toolsAndAuthOnly", threadId });

test("one ephemeral read-only thread, started lazily and reused across calls", async (t) => {
  const { dir, def, methods, requests } = setup(t);
  const control = createCodexControl({ def, cwd: dir });
  t.after(() => control.close());
  assert.equal(control.running, false);
  assert.deepEqual(await control.requestOnThread("mcpServerStatus/list", listStatus), CODEX_MCP_STATUS_LIST);
  await control.requestOnThread("mcpServerStatus/list", listStatus);
  assert.equal(control.running, true);
  assert.deepEqual(
    methods().filter((method) => method !== "initialized"),
    ["initialize", "thread/start", "mcpServerStatus/list", "mcpServerStatus/list"],
  );
  // Never a thread that could write or persist anything.
  assert.deepEqual(requests().find((request) => request.method === "thread/start")?.params, { ephemeral: true, cwd: dir, sandbox: "read-only", approvalPolicy: "never" });
});

test("a thread the app-server no longer knows is started again and the call retried once", async (t) => {
  const { dir, def, methods, forgetFile } = setup(t);
  const control = createCodexControl({ def, cwd: dir });
  t.after(() => control.close());
  await control.requestOnThread("mcpServerStatus/list", listStatus);
  writeFileSync(forgetFile, "");
  const result = (await control.callTool("jira-local", "jira_get_issue", { issue_key: "NGL-1" })) as { content: { text: string }[]; isError: boolean };
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), { server: "jira-local", tool: "jira_get_issue", arguments: { issue_key: "NGL-1" } });
  assert.equal(methods().filter((method) => method === "thread/start").length, 2);
});

test("no answer in time: rejected with a timeout and the daemon is stopped; the next call starts a new one", async (t) => {
  const { dir, def, methods } = setup(t, { FAKE_CODEX_MCP_STATUS_HANG: "1" });
  const control = createCodexControl({ def, cwd: dir, requestTimeoutMs: 300 });
  t.after(() => control.close());
  await assert.rejects(control.requestOnThread("mcpServerStatus/list", listStatus), CodexControlTimeout);
  assert.equal(control.running, false);
  await assert.rejects(control.requestOnThread("mcpServerStatus/list", listStatus), CodexControlTimeout);
  assert.equal(methods().filter((method) => method === "initialize").length, 2);
});

test("reload goes to a running daemon and is a no-op without one", async (t) => {
  const { dir, def, methods } = setup(t);
  const control = createCodexControl({ def, cwd: dir });
  t.after(() => control.close());
  await control.reload();
  assert.deepEqual(methods(), []);
  await control.request("mcpServerStatus/list", {});
  await control.reload();
  assert.ok(methods().includes("config/mcpServer/reload"));
});

test("a stopped daemon that exits after its successor started leaves the successor in use", async (t) => {
  const { dir, def, methods } = setup(t, { FAKE_CODEX_MCP_STATUS_HANG: "1" });
  let spawns = 0;
  const control = createCodexControl({
    def,
    cwd: dir,
    requestTimeoutMs: 300,
    // The first daemon's exit is reported late, as a slow SIGTERM would be.
    spawnDaemon: (options) => {
      const late = spawns++ === 0;
      return spawnCodexDaemon({ ...options, onExit: (reason) => (late ? setTimeout(() => options.onExit(reason), 400) : options.onExit(reason)) });
    },
  });
  t.after(() => control.close());
  await assert.rejects(control.request("mcpServerStatus/list", {}), CodexControlTimeout);
  await control.request("config/mcpServer/reload", {});
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(control.running, true, "still the second daemon");
  await control.request("config/mcpServer/reload", {});
  assert.equal(methods().filter((method) => method === "initialize").length, 2);
});
