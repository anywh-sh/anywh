// Reading through the picked server: routing between CLIs, finding the site
// once, and the refusal that happens before a call. The caller is a plain
// object answering like a server would. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeMcpStatus } from "./inventory/claude.js";
import { CLAUDE_MCP_STATUS_SETTLED } from "./inventory/fixtures.js";
import { JIRA_RECOGNIZER, pickIntegration } from "./match.js";
import { createIntegrationReader } from "./reader.js";
import type { IntegrationReadRequest } from "./service.js";
import type { McpToolCaller } from "./toolCaller.js";
import type { ToolCallOutcome } from "./toolResult.js";
import type { McpInventoryEntry } from "./types.js";

const NOW = 1_793_320_000_000;
const SITE = { id: "cloud-1", url: "https://example-team.atlassian.net", name: "example-team" };
const CLAUDE = (parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED) ?? []).map((report): McpInventoryEntry => ({ runtimeId: "claude", ...report, scannedAt: NOW })).filter((entry) => entry.scope !== "project");
const claudeAtlassian = CLAUDE.find((entry) => entry.name === "claude.ai Atlassian");
assert.ok(claudeAtlassian?.tools);
const CODEX: McpInventoryEntry = {
  runtimeId: "codex",
  name: "atlassian",
  scope: "user",
  transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" },
  status: "connected",
  authMode: "oauth",
  serverInfoName: "atlassian-mcp-server",
  tools: claudeAtlassian.tools,
  scannedAt: NOW,
};

const ok = (value: unknown): ToolCallOutcome => ({ ok: true, value });
const node = (key: string) => ({ id: "1", key, fields: { summary: key, status: { name: "To Do", statusCategory: { key: "new" } }, project: { key: key.split("-")[0] }, updated: "2026-11-05T09:00:00.000+0000" } });

function caller(answer: (server: McpInventoryEntry, tool: string, args: Record<string, unknown>) => ToolCallOutcome) {
  const calls: { runtimeId: string; tool: string; args: Record<string, unknown> }[] = [];
  const instance: McpToolCaller & { calls: typeof calls; closed: boolean } = {
    calls,
    closed: false,
    call(server, tool, args) {
      calls.push({ runtimeId: server.runtimeId, tool, args });
      return Promise.resolve(answer(server, tool, args));
    },
    close() {
      instance.closed = true;
    },
  };
  return instance;
}

function atlassian(server: McpInventoryEntry, tool: string): ToolCallOutcome {
  if (tool === "getAccessibleAtlassianResources") return ok([{ ...SITE, scopes: ["read:jira-work"] }]);
  if (tool === "searchJiraIssuesUsingJql") return ok({ issues: { nodes: [node(`NGL-${server.runtimeId === "codex" ? 2 : 1}`)], pageInfo: { hasNextPage: true, endCursor: "next" } } });
  if (tool === "getJiraIssue") return ok({ ...node("NGL-9"), fields: { ...node("NGL-9").fields, description: "Body", comment: { comments: [] } } });
  return { ok: false, kind: "tool", message: `Tool ${tool} not found` };
}

const MINE: IntegrationReadRequest = { integrationId: "jira", provider: "jira", query: "mine", param: null };

test("the first read finds the site, then lists; the site goes back with the result", async () => {
  const tools = caller(atlassian);
  const reader = createIntegrationReader(tools);
  const result = await reader.read(MINE, { picks: pickIntegration(CLAUDE, JIRA_RECOGNIZER) });
  assert.ok(result.ok);
  assert.equal(result.runtimeId, "claude");
  assert.deepEqual(result.site, SITE);
  assert.deepEqual(result.items?.map((row) => row.key), ["NGL-1"]);
  assert.equal(result.nextPageToken, "next");
  assert.deepEqual(tools.calls.map((call) => call.tool), ["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql"]);
  assert.equal(tools.calls[1].args.cloudId, "cloud-1");

  // Known site: one call, no site in the result.
  const again = await reader.read({ ...MINE, param: "NGL", pageToken: "next" }, { picks: pickIntegration(CLAUDE, JIRA_RECOGNIZER), site: SITE });
  assert.ok(again.ok && again.site === undefined);
  assert.equal(tools.calls.length, 3);
  assert.equal(tools.calls[2].args.nextPageToken, "next");
  assert.match(String(tools.calls[2].args.jql), /project = "NGL" ORDER BY updated DESC$/);
  reader.close?.();
  assert.equal(tools.closed, true);
});

test("Codex is read first; a sign-in it lacks sends the read to Claude", async () => {
  const picks = pickIntegration([...CLAUDE, CODEX], JIRA_RECOGNIZER);
  const both = caller(atlassian);
  const first = await createIntegrationReader(both).read(MINE, { picks, site: SITE });
  assert.ok(first.ok && first.runtimeId === "codex");

  const badToken = caller((server, tool) => (server.runtimeId === "codex" ? { ok: false, kind: "tool", message: `MCP error -32602: Tool ${tool} not found` } : atlassian(server, tool)));
  const fallback = await createIntegrationReader(badToken).read(MINE, { picks, site: SITE });
  assert.ok(fallback.ok);
  assert.equal(fallback.runtimeId, "claude");
  assert.deepEqual(badToken.calls.map((call) => call.runtimeId), ["codex", "claude"]);
  // ...and names the server that wants a sign-in, for the inventory.
  assert.deepEqual(fallback.needsAuth?.map((entry) => [entry.runtimeId, entry.name]), [["codex", "atlassian"]]);
  assert.equal(first.needsAuth, undefined);

  // A plain error does not move to the other CLI.
  const broken = caller((server, tool) => (server.runtimeId === "codex" ? { ok: false, kind: "tool", message: "Issue does not exist" } : atlassian(server, tool)));
  const failed = await createIntegrationReader(broken).read(MINE, { picks, site: SITE });
  assert.deepEqual(failed, { ok: false, status: "error", error: { kind: "tool", message: "Issue does not exist" } });
  assert.equal(broken.calls.length, 1);
});

test("a tool the server does not mark read-only is refused before any call reaches it", async () => {
  const lying: McpInventoryEntry = { ...CODEX, tools: (CODEX.tools ?? []).map((tool) => (tool.name === "searchJiraIssuesUsingJql" ? { name: tool.name, readOnly: false } : tool)) };
  const tools = caller(atlassian);
  const result = await createIntegrationReader(tools).read(MINE, { picks: pickIntegration([lying], JIRA_RECOGNIZER), site: SITE });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.status === "error" && /not_read_only/.test(result.error.message ?? ""));
  assert.deepEqual(tools.calls, []);
});

test("nothing connected: a pick that needs a sign-in says so, with no call", async () => {
  const tools = caller(atlassian);
  const needsAuth = await createIntegrationReader(tools).read(MINE, { picks: pickIntegration([{ ...CODEX, status: "needs_auth" }], JIRA_RECOGNIZER) });
  assert.equal(needsAuth.ok, false);
  assert.ok(!needsAuth.ok && needsAuth.status === "needs_auth");
  const none = await createIntegrationReader(tools).read(MINE, { picks: [] });
  assert.ok(!none.ok && none.status === "error");
  assert.deepEqual(tools.calls, []);
});

test("a ticket is read with its key", async () => {
  const tools = caller(atlassian);
  const result = await createIntegrationReader(tools).read({ integrationId: "jira", provider: "jira", query: "ticket", param: "NGL-9" }, { picks: pickIntegration(CLAUDE, JIRA_RECOGNIZER), site: SITE });
  assert.ok(result.ok);
  assert.equal(result.detail?.key, "NGL-9");
  assert.equal(result.detail?.descriptionMd, "Body");
  assert.deepEqual(tools.calls.map((call) => [call.tool, call.args.issueIdOrKey]), [["getJiraIssue", "NGL-9"]]);
});
