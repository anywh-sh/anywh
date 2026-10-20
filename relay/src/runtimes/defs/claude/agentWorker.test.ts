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

test("parseUserMcpServers: servers switched off for this directory are not passed on", () => {
  const text = JSON.stringify({
    mcpServers: { a: { command: "x" }, b: { command: "y" }, c: { command: "z" } },
    projects: { "/repo": { disabledMcpServers: ["b"] }, "/other": { disabledMcpServers: ["a"] } },
    disabledMcpServers: ["c"],
  });
  assert.deepEqual(Object.keys(parseUserMcpServers(text, "/repo")), ["a"]);
  assert.deepEqual(Object.keys(parseUserMcpServers(text, "/other")), ["b"]);
  assert.deepEqual(Object.keys(parseUserMcpServers(text)), ["a", "b"]);
});

test("project,local also skips the user's settings.json (env, permissions, apiKeyHelper, default model)", () => {
  // Pinned on purpose: a worker does not see keys kept only in
  // ~/.claude/settings.json, so a login that depends on `apiKeyHelper` or
  // provider variables set there does not carry over. Forwarding them is a
  // separate decision; if this list ever gains "user", revisit agentWorker.ts.
  assert.ok(!AGENT_WORKER_SETTING_SOURCES.split(",").includes("user"));
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

test("mergeAgentWorkerMcpConfig: other top-level keys of the bridge config survive", () => {
  const bridges = JSON.stringify({ somethingElse: { keep: true }, mcpServers: { b: { type: "http", url: "u" } } });
  const merged = JSON.parse(mergeAgentWorkerMcpConfig(bridges, { a: { command: "x" } })!) as Record<string, unknown>;
  assert.deepEqual(merged.somethingElse, { keep: true });
});

test("mergeAgentWorkerMcpConfig: without user servers the bridge text is returned untouched, unparsed", () => {
  // Not valid JSON on purpose: proves it is never parsed on this path.
  assert.equal(mergeAgentWorkerMcpConfig("{not json", {}), "{not json");
});

test("mergeAgentWorkerMcpConfig: a bridge config that is malformed or not an object is passed through as text", () => {
  assert.equal(mergeAgentWorkerMcpConfig("{broken", { a: { command: "x" } }), "{broken");
  assert.equal(mergeAgentWorkerMcpConfig("[1,2]", { a: { command: "x" } }), "[1,2]");
  assert.equal(mergeAgentWorkerMcpConfig("null", { a: { command: "x" } }), "null");
});

test("mergeAgentWorkerMcpConfig: nothing to pass means no --mcp-config at all", () => {
  assert.equal(mergeAgentWorkerMcpConfig(undefined, {}), undefined);
});

test("mergeAgentWorkerMcpConfig: user servers alone still produce a config; bridges alone are returned as given", () => {
  assert.deepEqual(JSON.parse(mergeAgentWorkerMcpConfig(undefined, { a: { command: "x" } })!), { mcpServers: { a: { command: "x" } } });
  const bridges = JSON.stringify({ mcpServers: { b: { type: "http", url: "u" } } });
  assert.deepEqual(JSON.parse(mergeAgentWorkerMcpConfig(bridges, {})!), JSON.parse(bridges));
});
