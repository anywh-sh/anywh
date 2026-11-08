// "+ Add Jira" against fakes: the CLI's write (Codex's app-server request,
// which needs no process) and the inventory around it. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import { addIntegration, type IntegrationAddDeps } from "./add.js";
import type { McpInventoryEntry, McpRuntimeId } from "./types.js";

function fakes(options: { writeError?: string; listedAfterRescan?: McpInventoryEntry } = {}) {
  const entries: McpInventoryEntry[] = [];
  const writes: unknown[] = [];
  let rescans = 0;
  const deps: IntegrationAddDeps = {
    defs: [codexRuntimeDef],
    neutralCwd: "/neutral",
    existing: (runtimeId) => entries.find((entry) => entry.runtimeId === runtimeId && entry.transport.url?.includes("atlassian")),
    names: (runtimeId) => entries.filter((entry) => entry.runtimeId === runtimeId).map((entry) => entry.name),
    codexRequest: (_method, params) => {
      writes.push(params);
      return options.writeError ? Promise.reject(new Error(options.writeError)) : Promise.resolve({});
    },
    // A live scan that never ends: the add must not wait for it.
    rescan: () => {
      rescans += 1;
      if (options.writeError && options.listedAfterRescan) {
        entries.push(options.listedAfterRescan);
        return Promise.resolve();
      }
      return new Promise(() => {});
    },
    declared: (runtimeId: McpRuntimeId, server) => entries.push({ runtimeId, ...server, status: "needs_auth", scannedAt: 0 }),
  };
  return { deps, entries, writes, rescans: () => rescans };
}

test("a declared server is noted and handed to sign-in at once, before the rescan behind it ends", async () => {
  const f = fakes();
  const result = await addIntegration(f.deps, "jira", ["codex"]);
  assert.deepEqual(result, { targets: [{ runtimeId: "codex", serverName: "atlassian" }], failures: [] });
  assert.equal(f.entries[0]?.name, "atlassian");
  assert.equal(f.entries[0]?.status, "needs_auth");
  assert.equal(f.rescans(), 1, "rescanned behind");
});

test("an add asked again once the server is declared writes nothing new and no second name", async () => {
  const f = fakes();
  await addIntegration(f.deps, "jira", ["codex"]);
  const again = await addIntegration(f.deps, "jira", ["codex"]);
  assert.deepEqual(again.targets, [{ runtimeId: "codex", serverName: "atlassian" }]);
  assert.equal(f.writes.length, 1, "one write");
  assert.deepEqual(
    f.entries.map((entry) => entry.name),
    ["atlassian"],
    "no atlassian-anywh",
  );
});

test("a server the CLI already has but the inventory has not listed yet is the one signed in to", async () => {
  const listed: McpInventoryEntry = { runtimeId: "codex", name: "atlassian", scope: "user", transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, status: "needs_auth", authMode: "oauth", scannedAt: 0 };
  const f = fakes({ writeError: "MCP server atlassian already exists in user config", listedAfterRescan: listed });
  const result = await addIntegration(f.deps, "jira", ["codex"]);
  assert.deepEqual(result, { targets: [{ runtimeId: "codex", serverName: "atlassian" }], failures: [] });
});

test("a write that fails is a failure", async () => {
  const f = fakes({ writeError: "permission denied" });
  const result = await addIntegration(f.deps, "jira", ["codex"]);
  assert.deepEqual(result, { targets: [], failures: [{ runtimeId: "codex", error: "permission denied" }] });
});
