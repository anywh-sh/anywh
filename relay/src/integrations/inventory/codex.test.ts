import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRuntimeDef } from "../../runtimes/defs/codex.js";
import { parseCodexMcpList, parseCodexMcpServerStatusList, parseCodexStartupStatus } from "./codex.js";
import { CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST, CODEX_MCP_STATUS_LIST_STARTING, CODEX_RECORDED_WITH, CODEX_STARTUP_NOT_LOGGED_IN } from "./fixtures.js";

test("the def's inventory contract is the one these fixtures were recorded against", () => {
  const { mcp } = codexRuntimeDef.portability;
  assert.equal(mcp.kind, "supported");
  assert.equal(mcp.inventory?.kind, "cli-json");
  assert.equal(mcp.inventory.recordedWith, CODEX_RECORDED_WITH);
  assert.deepEqual(mcp.inventory.args, ["mcp", "list", "--json"]);
  assert.equal(mcp.inventory.live.method, "mcpServerStatus/list");
  assert.deepEqual(mcp.inventory.live.params("thr-1", undefined), { detail: "toolsAndAuthOnly", threadId: "thr-1" });
  assert.deepEqual(mcp.inventory.live.params("thr-1", "c2"), { detail: "toolsAndAuthOnly", threadId: "thr-1", cursor: "c2" });
});

test("parseCodexMcpList: declared servers, the disabled one left out", () => {
  const reports = parseCodexMcpList(CODEX_MCP_LIST_STDOUT);
  assert.deepEqual(reports, [
    { name: "atlassian", scope: "user", transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, status: "needs_auth", authMode: "oauth" },
    { name: "deepwiki", scope: "user", transport: { type: "http", url: "https://mcp.deepwiki.com/mcp" }, status: "unknown", authMode: "none" },
    {
      name: "jira-local",
      scope: "user",
      transport: { type: "stdio", command: "uvx", args: ["mcp-atlassian"], envKeys: ["JIRA_URL", "JIRA_API_TOKEN"] },
      status: "unknown",
      authMode: "none",
    },
  ]);
});

test("parseCodexMcpList: a credential on file is not a verdict; a warning before the JSON is skipped; garbage is undefined", () => {
  const stdout = `WARNING: something\n${JSON.stringify([{ name: "a", enabled: true, transport: { type: "streamable_http", url: "https://a.test/mcp?k=1" }, auth_status: "o_auth" }])}`;
  assert.deepEqual(parseCodexMcpList(stdout), [{ name: "a", scope: "user", transport: { type: "http", url: "https://a.test/mcp" }, status: "unknown", authMode: "oauth" }]);
  assert.deepEqual(parseCodexMcpList("[]"), []);
  assert.equal(parseCodexMcpList("error: no config"), undefined);
  assert.equal(parseCodexMcpList('{"a":1}'), undefined);
});

test("parseCodexMcpServerStatusList: live state, catalog with readOnlyHint, and the not-logged-in reply", () => {
  const parsed = parseCodexMcpServerStatusList(CODEX_MCP_STATUS_LIST);
  assert.ok(parsed);
  assert.equal(parsed.nextCursor, undefined);
  const [atlassian, deepwiki, jira] = parsed.servers;
  // An empty catalog next to a startup failure is no catalog at all.
  assert.deepEqual(atlassian, { name: "atlassian", status: "needs_auth", authMode: "oauth" });
  assert.deepEqual(deepwiki, { name: "deepwiki", status: "connected", authMode: "none", serverInfoName: "DeepWiki", tools: [{ name: "read_wiki_structure", readOnly: true }] });
  assert.equal(jira.status, "connected");
  assert.deepEqual(jira.tools, [
    { name: "jira_search", readOnly: true },
    { name: "jira_get_issue", readOnly: true },
    { name: "jira_create_issue", readOnly: false },
  ]);
});

test("parseCodexMcpServerStatusList: starting servers are pending; no thread means status from auth and catalog; cursor kept", () => {
  assert.ok(parseCodexMcpServerStatusList(CODEX_MCP_STATUS_LIST_STARTING)?.servers.every((server) => server.status === "pending"));
  const withoutThread = parseCodexMcpServerStatusList({
    data: [
      { name: "a", runtimeStatus: null, tools: {}, toolsError: null, authStatus: "unsupported" },
      { name: "b", runtimeStatus: null, tools: {}, toolsError: "MCP startup failed", authStatus: "unsupported" },
      { name: "c", runtimeStatus: null, tools: {}, toolsError: "Auth required", authStatus: "notLoggedIn" },
      { name: "d", runtimeStatus: "disabled", tools: {}, toolsError: null, authStatus: "unsupported" },
    ],
    nextCursor: "next",
  });
  assert.deepEqual(
    withoutThread?.servers.map((server) => [server.name, server.status]),
    [
      ["a", "connected"],
      ["b", "failed"],
      ["c", "needs_auth"],
    ],
  );
  assert.equal(withoutThread?.nextCursor, "next");
  assert.equal(parseCodexMcpServerStatusList({ servers: [] }), undefined);
});

test("parseCodexStartupStatus: ready, starting, not logged in, reauthentication, other failures", () => {
  assert.deepEqual(parseCodexStartupStatus(CODEX_STARTUP_NOT_LOGGED_IN), { name: "atlassian", status: "needs_auth" });
  assert.deepEqual(parseCodexStartupStatus({ name: "a", status: "failed", error: null, failureReason: "reauthenticationRequired" }), { name: "a", status: "needs_auth" });
  assert.deepEqual(parseCodexStartupStatus({ name: "a", status: "failed", error: "spawn ENOENT", failureReason: null }), { name: "a", status: "failed" });
  assert.deepEqual(parseCodexStartupStatus({ name: "a", status: "ready" }), { name: "a", status: "connected" });
  assert.deepEqual(parseCodexStartupStatus({ name: "a", status: "starting" }), { name: "a", status: "pending" });
  assert.equal(parseCodexStartupStatus({ name: "a", status: "cancelled" }), undefined);
  assert.equal(parseCodexStartupStatus(null), undefined);
});
