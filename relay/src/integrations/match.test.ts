import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeMcpStatus } from "./inventory/claude.js";
import { parseCodexMcpList, parseCodexMcpServerStatusList } from "./inventory/codex.js";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "./inventory/fixtures.js";
import { integrationRuntimes, JIRA_RECOGNIZER, pickIntegration } from "./match.js";
import type { McpInventoryEntry } from "./types.js";

const PROJECT = "/work/ngl/ios";

function claudeEntries(): McpInventoryEntry[] {
  const reports = parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED) ?? [];
  return reports.map((report) => ({
    runtimeId: "claude",
    ...report,
    ...(report.scope === "project" || report.scope === "local" ? { cwd: PROJECT } : {}),
    scannedAt: 1,
  }));
}

function codexEntries(): McpInventoryEntry[] {
  const live = new Map((parseCodexMcpServerStatusList(CODEX_MCP_STATUS_LIST)?.servers ?? []).map((server) => [server.name, server]));
  return (parseCodexMcpList(CODEX_MCP_LIST_STDOUT) ?? []).map((report) => ({ runtimeId: "codex", ...report, ...live.get(report.name), scannedAt: 1 }));
}

function entry(overrides: Partial<McpInventoryEntry> & Pick<McpInventoryEntry, "name">): McpInventoryEntry {
  return { runtimeId: "claude", scope: "user", transport: { type: "stdio", command: "node" }, status: "connected", authMode: "none", scannedAt: 1, ...overrides };
}

test("recorded Claude profile: one Jira integration, the connected claude.ai v1 connector, the other two as alternatives", () => {
  const [pick, ...others] = pickIntegration(claudeEntries(), JIRA_RECOGNIZER);
  assert.equal(others.length, 0);
  assert.equal(pick.runtimeId, "claude");
  assert.equal(pick.chosen.name, "claude.ai Atlassian");
  assert.equal(pick.tier, "host");
  assert.equal(pick.status, "connected");
  // needs-auth v2 connector (account-wide) before the project's own copy.
  assert.deepEqual(
    pick.alternatives.map((alternative) => [alternative.name, alternative.scope]),
    [
      ["claude.ai Atlassian MCP", "claudeai"],
      ["atlassian", "project"],
    ],
  );
  assert.deepEqual(integrationRuntimes([pick]), [{ runtimeId: "claude", serverName: "claude.ai Atlassian", scope: "claudeai", status: "connected", authMode: "claudeai", alternatives: 2 }]);
});

test("recorded Codex profile: the connected community server wins over the official one needing a sign-in", () => {
  const [pick] = pickIntegration(codexEntries(), JIRA_RECOGNIZER);
  assert.equal(pick.chosen.name, "jira-local");
  assert.equal(pick.tier, "package");
  assert.equal(pick.status, "connected");
  assert.deepEqual(
    pick.alternatives.map((alternative) => alternative.name),
    ["atlassian"],
  );
});

test("statically, before any live read, the official server needing a sign-in ranks first", () => {
  const entries = (parseCodexMcpList(CODEX_MCP_LIST_STDOUT) ?? []).map((report): McpInventoryEntry => ({ runtimeId: "codex", ...report, scannedAt: 1 }));
  const [pick] = pickIntegration(entries, JIRA_RECOGNIZER);
  assert.equal(pick.chosen.name, "atlassian");
  assert.equal(pick.status, "needs_auth");
  assert.equal(pick.alternatives.length, 1);
});

test("both CLIs of a profile: one pick each, Claude first", () => {
  const picks = pickIntegration([...codexEntries(), ...claudeEntries()], JIRA_RECOGNIZER);
  assert.deepEqual(
    picks.map((pick) => [pick.runtimeId, pick.chosen.name]),
    [
      ["claude", "claude.ai Atlassian"],
      ["codex", "jira-local"],
    ],
  );
});

test("the official server connected with a catalog missing every Jira tool (a bad token) needs a sign-in", () => {
  const badToken = entry({
    name: "atlassian",
    transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" },
    authMode: "none",
    tools: [{ name: "getTeamworkGraphContext", readOnly: true }, { name: "getContentFormatGuide", readOnly: true }],
  });
  const [pick] = pickIntegration([badToken], JIRA_RECOGNIZER);
  assert.equal(pick.status, "needs_auth");
});

test("recognition tiers: serverInfo, a stdio bridge to the host, *.atlassian.net, env names, tools, name", () => {
  const tierOf = (candidate: McpInventoryEntry) => JIRA_RECOGNIZER.recognize(candidate);
  assert.equal(tierOf(entry({ name: "proxy", transport: { type: "http", url: "https://proxy.corp.test/mcp" }, serverInfoName: "atlassian-mcp-server" })), "serverInfo");
  assert.equal(tierOf(entry({ name: "bridge", transport: { type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"] } })), "host");
  assert.equal(tierOf(entry({ name: "site", transport: { type: "http", url: "https://acme.atlassian.net/mcp" } })), "host");
  assert.equal(tierOf(entry({ name: "img", transport: { type: "stdio", command: "docker", args: ["run", "-i", "ghcr.io/sooperset/mcp-atlassian:latest"] } })), "package");
  assert.equal(tierOf(entry({ name: "pinned", transport: { type: "stdio", command: "npx", args: ["@aashari/mcp-server-atlassian-jira@1.2.0"] } })), "package");
  assert.equal(tierOf(entry({ name: "custom", transport: { type: "stdio", command: "node", args: ["server.js"], envKeys: ["JIRA_URL"] } })), "package");
  assert.equal(tierOf(entry({ name: "custom", tools: [{ name: "get_jira_ticket" }] })), "tools");
  assert.equal(tierOf(entry({ name: "my jira notes" })), "name");
  assert.equal(tierOf(entry({ name: "sentry", transport: { type: "http", url: "https://mcp.sentry.dev/mcp" } })), undefined);
});

test("a non-official Atlassian server whose catalog has no Jira tool is not Jira (Confluence only)", () => {
  assert.equal(JIRA_RECOGNIZER.recognize(entry({ name: "atlassian-wiki", transport: { type: "stdio", command: "uvx", args: ["mcp-atlassian"] }, tools: [{ name: "confluence_search" }] })), undefined);
});

test("a server recognized only by its name never wins over one recognized otherwise, even connected", () => {
  const byName = entry({ name: "jira-helper", status: "connected" });
  const official = entry({ name: "atlassian", transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, status: "needs_auth", authMode: "oauth" });
  const [pick] = pickIntegration([byName, official], JIRA_RECOGNIZER);
  assert.equal(pick.chosen.name, "atlassian");
  assert.equal(pick.alternatives[0].name, "jira-helper");
});

test("same status: user/claude.ai over plugin over project; pending counts as unknown", () => {
  const url = "https://mcp.atlassian.com/v1/mcp";
  const project = entry({ name: "atlassian", scope: "project", cwd: "/p", transport: { type: "http", url }, status: "needs_auth" });
  const plugin = entry({ name: "plugin:atl:atl", scope: "plugin", transport: { type: "http", url }, status: "needs_auth" });
  const user = entry({ name: "jira", scope: "user", transport: { type: "http", url }, status: "needs_auth" });
  const pending = entry({ name: "pending", scope: "user", transport: { type: "http", url }, status: "pending" });
  const [pick] = pickIntegration([project, pending, plugin, user], JIRA_RECOGNIZER);
  assert.deepEqual([pick.chosen.name, ...pick.alternatives.map((alternative) => alternative.name)], ["jira", "plugin:atl:atl", "atlassian", "pending"]);
  const [onlyPending] = pickIntegration([pending], JIRA_RECOGNIZER);
  assert.equal(onlyPending.status, "unknown");
  assert.deepEqual(integrationRuntimes([pickIntegration([project], JIRA_RECOGNIZER)[0]])[0].cwd, "/p");
});

test("nothing that matches: no pick", () => {
  assert.deepEqual(pickIntegration([entry({ name: "sentry" })], JIRA_RECOGNIZER), []);
});

test("Trello's claude.ai connector, also served by Atlassian, is not Jira", () => {
  // Recorded shape (redacted): a claude.ai connector for Trello reports the
  // same serverInfo name as Atlassian's Jira server, at its own host, with
  // Trello's tools only.
  const trello = entry({
    name: "claude.ai Trello",
    scope: "claudeai",
    authMode: "claudeai",
    transport: { type: "claudeai-proxy", url: "https://mcp.trello.com/v1" },
    serverInfoName: "atlassian-mcp-server",
    tools: [{ name: "trelloReadCard", readOnly: true }, { name: "trelloReadBoard", readOnly: true }],
  });
  assert.equal(JIRA_RECOGNIZER.recognize(trello), undefined);
  assert.deepEqual(pickIntegration([trello], JIRA_RECOGNIZER), []);
  // Signed out, with no catalog to tell it by, its host still does.
  const signedOut = { ...trello, status: "needs_auth" as const, tools: [] };
  assert.equal(JIRA_RECOGNIZER.recognize(signedOut), undefined);
});
