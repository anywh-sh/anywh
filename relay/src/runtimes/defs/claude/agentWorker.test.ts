import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_WORKER_SETTING_SOURCES, mergeAgentWorkerMcpConfig, parseUserMcpServers } from "./agentWorker.js";

function servers(configJson: string | undefined): Record<string, unknown> {
  assert.ok(configJson);
  return (JSON.parse(configJson) as { mcpServers: Record<string, unknown> }).mcpServers;
}

test("keeps only the project and local settings sources", () => {
  // `user` is what carries personal plugins, skills, hooks and the user-scope
  // MCP list; `project` and `local` stay so the repo's own `.mcp.json`,
  // `.claude/` skills and hooks keep working for a worker.
  assert.equal(AGENT_WORKER_SETTING_SOURCES, "project,local");
});

test("parseUserMcpServers: reads the top-level mcpServers map of ~/.claude.json", () => {
  const text = JSON.stringify({
    numStartups: 3,
    mcpServers: { posthog: { type: "http", url: "https://example.test/mcp" }, local: { type: "stdio", command: "node", args: ["x.js"] } },
    projects: { "/some/repo": { mcpServers: { webflow: { type: "http", url: "https://x.test" } } } },
  });
  // Per-project (local scope) servers are NOT read here: `--setting-sources
  // project,local` already loads them natively.
  assert.deepEqual(Object.keys(parseUserMcpServers(text)), ["posthog", "local"]);
});

test("parseUserMcpServers: tolerates absent, malformed or non-object input", () => {
  assert.deepEqual(parseUserMcpServers(undefined), {});
  assert.deepEqual(parseUserMcpServers("not json"), {});
  assert.deepEqual(parseUserMcpServers("[]"), {});
  assert.deepEqual(parseUserMcpServers(JSON.stringify({ mcpServers: "nope" })), {});
  assert.deepEqual(parseUserMcpServers(JSON.stringify({ mcpServers: { ok: { command: "x" }, bad: 3, worse: null } })), { ok: { command: "x" } });
});

test("mergeAgentWorkerMcpConfig: user servers and bridges end up in one config", () => {
  const bridges = JSON.stringify({ mcpServers: { "anywh-choice": { type: "http", url: "http://127.0.0.1:1/t", alwaysLoad: true } } });
  const merged = mergeAgentWorkerMcpConfig(bridges, { posthog: { type: "http", url: "https://example.test/mcp" } });
  assert.ok(merged);
  assert.deepEqual(Object.keys(servers(merged)).sort(), ["anywh-choice", "posthog"]);
});

test("mergeAgentWorkerMcpConfig: a bridge always wins a name clash with a user server", () => {
  const bridges = JSON.stringify({ mcpServers: { "anywh-choice": { type: "http", url: "http://relay/bridge" } } });
  const merged = mergeAgentWorkerMcpConfig(bridges, { "anywh-choice": { type: "stdio", command: "evil" } });
  assert.deepEqual(servers(merged)["anywh-choice"], { type: "http", url: "http://relay/bridge" });
});

test("mergeAgentWorkerMcpConfig: nothing to pass means no --mcp-config at all", () => {
  assert.equal(mergeAgentWorkerMcpConfig(undefined, {}), undefined);
});

test("mergeAgentWorkerMcpConfig: user servers alone still produce a config; bridges alone are returned as given", () => {
  assert.deepEqual(JSON.parse(mergeAgentWorkerMcpConfig(undefined, { a: { command: "x" } })!), { mcpServers: { a: { command: "x" } } });
  const bridges = JSON.stringify({ mcpServers: { b: { type: "http", url: "u" } } });
  assert.deepEqual(JSON.parse(mergeAgentWorkerMcpConfig(bridges, {})!), JSON.parse(bridges));
});
