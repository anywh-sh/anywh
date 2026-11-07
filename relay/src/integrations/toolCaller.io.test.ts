// Direct MCP tool calls against real children: the fake `claude` answering
// `mcp_status`/`mcp_call` on a turnless process (isolated to one server, or
// the ordinary one), and the fake `codex app-server` answering
// `mcpServer/tool/call`, both with the Atlassian replies of
// tests/fixtures/fake-atlassian.mjs. Proves the wiring (argv, isolation and
// its fallback, the thread, the result read back), never the CLIs'
// behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { ClaudeControlPool } from "./claudeControl.js";
import { createCodexControl } from "./codexControl.js";
import { parseClaudeMcpStatus } from "./inventory/claude.js";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "./inventory/fixtures.js";
import { JIRA_RECOGNIZER, pickIntegration } from "./match.js";
import { createIntegrationReader } from "./reader.js";
import { RuntimeToolCaller } from "./toolCaller.js";
import type { McpInventoryEntry } from "./types.js";

const FAKE_CLAUDE = resolve(import.meta.dirname, "../../tests/fixtures/fake-claude.mjs");
const FAKE_CODEX = resolve(import.meta.dirname, "../../tests/fixtures/fake-codex-app-server.mjs");
const NOW = 1_793_320_000_000;

const readLines = <T>(file: string): T[] => {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
};

type Call = { via: string; server: string; tool: string; arguments: Record<string, unknown> | null; isolated: boolean };

function setup(t: { after: (fn: () => void) => void }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-tool-caller-"));
  const files = {
    claudeStatus: join(dir, "claude-status.json"),
    codexList: join(dir, "codex-list.json"),
    codexStatus: join(dir, "codex-status.json"),
    calls: join(dir, "calls.jsonl"),
    invocations: join(dir, "invocations.jsonl"),
    mode: join(dir, "mode"),
  };
  writeFileSync(files.claudeStatus, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  writeFileSync(files.codexList, CODEX_MCP_LIST_STDOUT);
  writeFileSync(files.codexStatus, JSON.stringify(CODEX_MCP_STATUS_LIST));
  const set = {
    FAKE_CLAUDE_MCP_STATUS_FILE: files.claudeStatus,
    FAKE_CLAUDE_INVOCATIONS_FILE: files.invocations,
    FAKE_CODEX_MCP_LIST_FILE: files.codexList,
    FAKE_CODEX_MCP_STATUS_FILE: files.codexStatus,
    FAKE_ATLASSIAN_CALLS_FILE: files.calls,
    FAKE_ATLASSIAN_MODE_FILE: files.mode,
    ...env,
  };
  const claudeDef: AgentRuntimeDef = { ...claudeRuntimeDef, identity: { ...claudeRuntimeDef.identity, bin: FAKE_CLAUDE, env: { ...claudeRuntimeDef.identity.env, set: { ...claudeRuntimeDef.identity.env.set, ...set } } } };
  const codexDef: AgentRuntimeDef = { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin: FAKE_CODEX, env: { ...codexRuntimeDef.identity.env, set: { ...codexRuntimeDef.identity.env.set, ...set } } } };
  const claudePool = new ClaudeControlPool({ def: claudeDef, neutralCwd: dir });
  const codexControl = createCodexControl({ def: codexDef, cwd: dir });
  const caller = new RuntimeToolCaller({ defs: [claudeDef, codexDef], claudePool, codexControl, neutralCwd: dir, settleMs: 3000 });
  t.after(() => {
    caller.close();
    claudePool.close();
    codexControl.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const claudeEntries = (parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED) ?? []).map((report): McpInventoryEntry => ({ runtimeId: "claude", ...report, scannedAt: NOW })).filter((entry) => entry.scope !== "project");
  const claudeAtlassian = claudeEntries.find((entry) => entry.name === "claude.ai Atlassian");
  assert.ok(claudeAtlassian);
  return {
    files,
    caller,
    claudeEntries,
    claudeAtlassian,
    calls: () => readLines<Call>(files.calls),
    strictProcesses: () => readLines<{ args: string[] }>(files.invocations).filter(({ args }) => args.includes("--strict-mcp-config")),
  };
}

test("Claude: the call runs on a process with only that server, started once and reused", async (t) => {
  const h = setup(t);
  const sites = await h.caller.call(h.claudeAtlassian, "getAccessibleAtlassianResources", {});
  assert.ok(sites.ok, JSON.stringify(sites));
  assert.ok(Array.isArray(sites.value) && (sites.value[0] as { id: string }).id.length > 0);
  const page = await h.caller.call(h.claudeAtlassian, "searchJiraIssuesUsingJql", { cloudId: "c", jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", maxResults: 2 });
  assert.ok(page.ok);
  assert.equal((page.value as { issues: { nodes: unknown[] } }).issues.nodes.length, 2);
  assert.deepEqual(h.calls().map((call) => [call.via, call.server, call.tool, call.isolated]), [
    ["claude", "claude.ai Atlassian", "getAccessibleAtlassianResources", true],
    ["claude", "claude.ai Atlassian", "searchJiraIssuesUsingJql", true],
  ]);
  const [strict, ...more] = h.strictProcesses();
  assert.equal(more.length, 0, "one isolated process for both calls");
  const config = strict.args[strict.args.indexOf("--mcp-config") + 1];
  assert.ok(config.startsWith(tmpdir()));
});

test("Claude: a server that does not come up isolated is called on the ordinary process from then on", async (t) => {
  const h = setup(t, { FAKE_CLAUDE_MCP_ISOLATED_STATUS: "needs-auth" });
  const first = await h.caller.call(h.claudeAtlassian, "getAccessibleAtlassianResources", {});
  assert.ok(first.ok);
  const second = await h.caller.call(h.claudeAtlassian, "getAccessibleAtlassianResources", {});
  assert.ok(second.ok);
  assert.deepEqual(h.calls().map((call) => call.isolated), [false, false]);
  assert.equal(h.strictProcesses().length, 1, "isolation is not tried again");
});

test("Claude: a tool's own error comes back as the tool's, through the reader as needs_auth on a bad token", async (t) => {
  const h = setup(t);
  writeFileSync(h.files.mode, "bad_token");
  const raw = await h.caller.call(h.claudeAtlassian, "getJiraIssue", { issueIdOrKey: "NGL-1" });
  assert.ok(!raw.ok && raw.kind === "tool" && /Tool getJiraIssue not found/.test(raw.message));
  const read = await createIntegrationReader(h.caller).read({ integrationId: "jira", provider: "jira", query: "mine", param: null }, { picks: pickIntegration(h.claudeEntries, JIRA_RECOGNIZER) });
  assert.ok(!read.ok && read.status === "needs_auth", JSON.stringify(read));
});

test("Codex: the call runs on the control thread; a server with no login is a sign-in to do", async (t) => {
  const h = setup(t);
  const official: McpInventoryEntry = { runtimeId: "codex", name: "atlassian", scope: "user", transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, status: "needs_auth", authMode: "oauth", scannedAt: NOW };
  const noLogin = await h.caller.call(official, "getAccessibleAtlassianResources", {});
  assert.ok(!noLogin.ok && noLogin.kind === "transport" && /Auth required/.test(noLogin.message));

  // Signed in: the live status says connected and serves the catalog.
  writeFileSync(h.files.codexStatus, JSON.stringify({ data: [{ name: "atlassian", runtimeStatus: "connected", serverInfo: { name: "atlassian-mcp-server" }, tools: {}, authStatus: "oAuth" }], nextCursor: null }));
  const page = await h.caller.call(official, "searchJiraIssuesUsingJql", { cloudId: "c", jql: 'assignee = currentUser() AND statusCategory != Done AND project = "ABC" ORDER BY updated DESC' });
  assert.ok(page.ok, JSON.stringify(page));
  const keys = (page.value as { issues: { nodes: { key: string }[] } }).issues.nodes.map((node) => node.key);
  assert.deepEqual(keys, ["ABC-7"]);
  assert.deepEqual(h.calls().map((call) => [call.via, call.server, call.tool]), [["codex", "atlassian", "searchJiraIssuesUsingJql"]]);
  const project: McpInventoryEntry = { ...official, cwd: "/some/project" };
  const outside = await h.caller.call(project, "searchJiraIssuesUsingJql", {});
  assert.equal(outside.ok, false);
});
