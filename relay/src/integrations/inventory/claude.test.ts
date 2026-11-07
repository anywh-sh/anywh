import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeRuntimeDef } from "../../runtimes/defs/claude/index.js";
import { REDACTED_ARG, argsWithoutSecrets, claudeJsonMcpSlice, parseClaudeInitMcpServers, parseClaudeMcpStatus } from "./claude.js";
import { CLAUDE_INIT_EVENT, CLAUDE_MCP_STATUS_SETTLED, CLAUDE_MCP_STATUS_STARTING, CLAUDE_RECORDED_WITH } from "./fixtures.js";

const byName = (name: string) => parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED)?.find((report) => report.name === name);

test("the def's inventory contract is the one these fixtures were recorded against", () => {
  const { mcp } = claudeRuntimeDef.portability;
  assert.equal(mcp.kind, "supported");
  assert.equal(mcp.inventory?.kind, "control-request");
  assert.equal(mcp.inventory.recordedWith, CLAUDE_RECORDED_WITH);
  assert.equal(mcp.inventory.subtype, "mcp_status");
  // Isolating the MCP config would hide the connectors and plugins.
  assert.ok(!mcp.inventory.processArgs.includes("--strict-mcp-config"));
  assert.equal(mcp.inventory.parse, parseClaudeMcpStatus);
});

test("parseClaudeMcpStatus: every scope of the recorded reply, normalized", () => {
  const reports = parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED);
  assert.ok(reports);
  assert.equal(reports.length, CLAUDE_MCP_STATUS_SETTLED.mcpServers.length);
  assert.deepEqual(
    reports.map((report) => [report.name, report.scope, report.status]),
    [
      ["plugin:context7:context7", "plugin", "needs_auth"],
      ["plugin:playwright:playwright", "plugin", "connected"],
      ["simplelocalize", "user", "connected"],
      ["sentry", "user", "connected"],
      ["claude.ai Atlassian MCP", "claudeai", "needs_auth"],
      ["claude.ai Atlassian", "claudeai", "connected"],
      ["claude.ai Notion", "claudeai", "needs_auth"],
      ["atlassian", "project", "needs_auth"],
      ["figma", "project", "failed"],
    ],
  );
});

test("parseClaudeMcpStatus: a connector keeps its config for an isolated process, its tools and server name", () => {
  const v1 = byName("claude.ai Atlassian");
  assert.ok(v1);
  assert.deepEqual(v1.transport, { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp" });
  assert.equal(v1.authMode, "claudeai");
  assert.equal(v1.serverInfoName, "atlassian-mcp-server");
  assert.deepEqual(v1.claudeConfig, { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp", id: "mcpsrv_00000000000000000000000001" });
  assert.equal(v1.tools?.length, 41);
  assert.deepEqual(v1.tools?.find((tool) => tool.name === "getJiraIssue"), { name: "getJiraIssue", readOnly: true });
  // A write tool reports empty annotations: nothing to say.
  assert.deepEqual(v1.tools?.find((tool) => tool.name === "createJiraIssue"), { name: "createJiraIssue" });
});

test("parseClaudeMcpStatus: a query string never leaves the config (some servers take a key there)", () => {
  const context7 = byName("plugin:context7:context7");
  assert.equal(context7?.transport.url, "https://mcp.context7.com/mcp");
  assert.equal(context7?.authMode, "oauth");
  assert.equal(byName("simplelocalize")?.authMode, "none");
  assert.deepEqual(byName("simplelocalize")?.transport, { type: "stdio", command: "npx", args: ["-y", "@simplelocalize/simplelocalize-mcp"] });
});

test("parseClaudeMcpStatus: env and headers are not kept, only their names", () => {
  const reports = parseClaudeMcpStatus({
    mcpServers: [
      { name: "x", status: "connected", config: { type: "stdio", command: "jira-mcp", env: { JIRA_API_TOKEN: "secret-value" } }, scope: "user", source: "user" },
      { name: "y", status: "connected", config: { type: "http", url: "https://h.test/mcp", headers: { Authorization: "Bearer secret-value" } }, scope: "user", source: "user" },
    ],
  });
  assert.ok(reports);
  assert.deepEqual(reports[0].transport.envKeys, ["JIRA_API_TOKEN"]);
  assert.ok(!JSON.stringify(reports).includes("secret-value"));
});

test("parseClaudeMcpStatus: a starting process reports pending servers without a catalog", () => {
  const reports = parseClaudeMcpStatus(CLAUDE_MCP_STATUS_STARTING);
  const v1 = reports?.find((report) => report.name === "claude.ai Atlassian");
  assert.equal(v1?.status, "pending");
  assert.equal(v1?.tools, undefined);
});

test("parseClaudeMcpStatus: --mcp-config servers are `override`; disabled and unknown transports are left out; garbage is undefined", () => {
  const reports = parseClaudeMcpStatus({
    mcpServers: [
      { name: "claude.ai Atlassian", status: "connected", config: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp", id: "x" }, scope: "dynamic", source: "dynamic" },
      { name: "off", status: "disabled", config: { type: "stdio", command: "x" }, scope: "user", source: "user" },
      { name: "ide", status: "connected", config: { type: "ws-ide", url: "ws://127.0.0.1:1" }, scope: "dynamic", source: "dynamic" },
      { name: "odd", status: "starting-ish", config: { type: "http", url: "https://h.test" }, scope: "user", source: "user" },
      "not an object",
    ],
  });
  assert.deepEqual(
    reports?.map((report) => [report.name, report.scope, report.status]),
    [
      ["claude.ai Atlassian", "override", "connected"],
      ["odd", "user", "unknown"],
    ],
  );
  assert.equal(parseClaudeMcpStatus(undefined), undefined);
  assert.equal(parseClaudeMcpStatus({ models: [] }), undefined);
});

test("parseClaudeInitMcpServers: only needs-auth is believed from a turn's init", () => {
  assert.deepEqual(parseClaudeInitMcpServers(CLAUDE_INIT_EVENT), [{ name: "claude.ai Atlassian MCP", status: "needs_auth" }]);
  assert.deepEqual(parseClaudeInitMcpServers({ type: "assistant" }), []);
});

test("claudeJsonMcpSlice: ignores counters and caches, sees servers and approvals", () => {
  const base = { numStartups: 3, mcpServers: { a: { type: "http", url: "https://a.test" } }, projects: { "/p": { mcpServers: {}, enabledMcpjsonServers: [], lastCost: 1 } } };
  const slice = (value: unknown) => JSON.stringify(claudeJsonMcpSlice(JSON.stringify(value)));
  assert.equal(slice(base), slice({ ...base, numStartups: 4, projects: { "/p": { ...base.projects["/p"], lastCost: 2 } } }));
  assert.notEqual(slice(base), slice({ ...base, projects: { "/p": { ...base.projects["/p"], enabledMcpjsonServers: ["atlassian"] } } }));
  assert.notEqual(slice(base), slice({ ...base, mcpServers: {} }));
  assert.equal(claudeJsonMcpSlice("{ half-written"), undefined);
});

test("parseClaudeMcpStatus: a credential in a server's URL query or arguments is kept nowhere", () => {
  const reports = parseClaudeMcpStatus({
    mcpServers: [
      { name: "keyed", status: "connected", scope: "user", config: { type: "http", url: "https://mcp.example.com/mcp?api_key=SECRET1", headers: { Authorization: "Bearer SECRET2" } } },
      { name: "bridge", status: "connected", scope: "user", config: { type: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse?token=SECRET3", "--header", "Authorization: Bearer SECRET4"], env: { KEY: "SECRET5" } } },
      { name: "flagged", status: "connected", scope: "user", config: { type: "stdio", command: "jira-mcp", args: ["--api-key=SECRET6", "--token", "SECRET7"] } },
      { name: "plain", status: "connected", scope: "user", config: { type: "stdio", command: "uvx", args: ["mcp-atlassian", "--read-only"] } },
    ],
  });
  assert.ok(reports);
  assert.ok(!JSON.stringify(reports).includes("SECRET"), "no credential anywhere in the inventory");
  const byReport = (name: string) => reports.find((report) => report.name === name);
  assert.deepEqual(byReport("keyed")?.claudeConfig, { type: "http", url: "https://mcp.example.com/mcp" });
  // Without its credential it would not start: no isolated process for it.
  assert.equal(byReport("bridge")?.claudeConfig, undefined);
  assert.equal(byReport("flagged")?.claudeConfig, undefined);
  // What it runs is still told, for recognizing it.
  assert.deepEqual(byReport("bridge")?.transport.args, ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse", "--header", REDACTED_ARG]);
  assert.deepEqual(byReport("flagged")?.transport.args, [`--api-key=${REDACTED_ARG}`, "--token", REDACTED_ARG]);
  assert.deepEqual(byReport("plain")?.claudeConfig, { type: "stdio", command: "uvx", args: ["mcp-atlassian", "--read-only"] });
  assert.deepEqual(argsWithoutSecrets(["-H", "x-api-key: k"]), { args: ["-H", REDACTED_ARG], redacted: true });
});
