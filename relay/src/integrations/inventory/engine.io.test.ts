// The MCP inventory against real children — the fake `claude` answering
// `mcp_status`, the fake `codex` answering `mcp list --json` and the
// app-server's `mcpServerStatus/list`, with the recorded shapes in
// fixtures.ts — a real home directory and real `fs.watch`. Proves the
// scheduling (tiers, pending, timeouts, folders, rescans), not the CLIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeRuntimeDef } from "../../runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "../../runtimes/defs/codex.js";
import type { AgentRuntimeDef, McpContract } from "../../runtimes/types.js";
import { JIRA_RECOGNIZER, pickIntegration } from "../match.js";
import type { McpInventoryEntry } from "../types.js";
import { McpInventory, type McpInventoryOptions } from "./engine.js";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "./fixtures.js";

const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures");

type After = { after: (fn: () => void) => void };

function withSettle(def: AgentRuntimeDef, settleMs: number): AgentRuntimeDef {
  const mcp = def.portability.mcp as Extract<McpContract, { kind: "supported" }>;
  if (mcp.inventory?.kind !== "control-request") throw new Error("not a control-request def");
  return { ...def, portability: { ...def.portability, mcp: { ...mcp, inventory: { ...mcp.inventory, settleMs } } } };
}

function setup(t: After, options: { claudeEnv?: Record<string, string>; codexEnv?: Record<string, string>; settleMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-mcp-inventory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const neutral = join(dir, "neutral");
  const project = join(dir, "project");
  for (const path of [home, join(home, ".claude"), join(home, ".codex"), neutral, project]) mkdirSync(path, { recursive: true });
  const claudeStatus = join(dir, "claude-status.json");
  const codexList = join(dir, "codex-list.json");
  const codexStatus = join(dir, "codex-status.json");
  writeFileSync(claudeStatus, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  writeFileSync(codexList, CODEX_MCP_LIST_STDOUT);
  writeFileSync(codexStatus, JSON.stringify(CODEX_MCP_STATUS_LIST));
  const invocationsFile = join(dir, "claude-invocations.jsonl");
  const claude: AgentRuntimeDef = withSettle(
    {
      ...claudeRuntimeDef,
      identity: {
        ...claudeRuntimeDef.identity,
        bin: join(FIXTURES, "fake-claude.mjs"),
        env: {
          ...claudeRuntimeDef.identity.env,
          set: { ...claudeRuntimeDef.identity.env.set, FAKE_CLAUDE_MCP_STATUS_FILE: claudeStatus, FAKE_CLAUDE_INVOCATIONS_FILE: invocationsFile, ...options.claudeEnv },
        },
      },
    },
    options.settleMs ?? 2000,
  );
  const codex: AgentRuntimeDef = {
    ...codexRuntimeDef,
    identity: {
      ...codexRuntimeDef.identity,
      bin: join(FIXTURES, "fake-codex-app-server.mjs"),
      env: { ...codexRuntimeDef.identity.env, set: { FAKE_CODEX_MCP_LIST_FILE: codexList, FAKE_CODEX_MCP_STATUS_FILE: codexStatus, ...options.codexEnv } },
    },
  };
  const claudeInvocations = (): { cwd: string; home: string }[] => {
    try {
      return readFileSync(invocationsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { cwd: string; home: string });
    } catch {
      return [];
    }
  };
  const inventory = (extra: Partial<McpInventoryOptions> = {}, runtimes: AgentRuntimeDef[] = [claude, codex]) => {
    const created = new McpInventory({
      runtimes: runtimes.map((def) => ({ def })),
      homeOverride: home,
      env: {},
      neutralCwd: neutral,
      settlePollMs: 50,
      requestTimeoutMs: 2000,
      debounceMs: 100,
      ...extra,
    });
    t.after(() => created.close());
    return created;
  };
  return { dir, home, neutral, project, claudeStatus, codexStatus, claudeInvocations, inventory, claude, codex };
}

const names = (entries: McpInventoryEntry[], runtimeId: string) => entries.filter((entry) => entry.runtimeId === runtimeId).map((entry) => entry.name);

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a scan of both CLIs in the profile's home finds the recorded servers and one Jira integration each", async (t) => {
  const { home, neutral, claudeInvocations, inventory } = setup(t);
  const engine = inventory();
  const results = await engine.scan();
  assert.ok(results.every((result) => result.ok));
  const entries = engine.entries();
  // The neutral folder never owns a project's servers.
  assert.deepEqual(names(entries, "claude").sort(), ["claude.ai Atlassian", "claude.ai Atlassian MCP", "claude.ai Notion", "plugin:context7:context7", "plugin:playwright:playwright", "sentry", "simplelocalize"]);
  assert.deepEqual(names(entries, "codex"), ["atlassian", "deepwiki", "jira-local"]);
  assert.deepEqual(claudeInvocations().map((invocation) => [invocation.cwd, invocation.home]), [[neutral, home]]);
  // Codex: the live read laid over the declared list.
  const jiraLocal = entries.find((entry) => entry.runtimeId === "codex" && entry.name === "jira-local");
  assert.equal(jiraLocal?.status, "connected");
  assert.equal(jiraLocal?.serverInfoName, "mcp-atlassian");
  assert.deepEqual(
    pickIntegration(entries, JIRA_RECOGNIZER).map((pick) => [pick.runtimeId, pick.chosen.name, pick.status, pick.alternatives.length]),
    [
      ["claude", "claude.ai Atlassian", "connected", 1],
      ["codex", "jira-local", "connected", 1],
    ],
  );
});

test("a project folder adds only that project's own servers, tagged with it", async (t) => {
  const { project, inventory, claude } = setup(t);
  const engine = inventory({}, [claude]);
  await engine.scan();
  await engine.scan({ cwd: project });
  const projectEntries = engine.entries().filter((entry) => entry.cwd !== undefined);
  assert.deepEqual(
    projectEntries.map((entry) => [entry.name, entry.scope, entry.cwd]),
    [
      ["atlassian", "project", project],
      ["figma", "project", project],
    ],
  );
  const [pick] = pickIntegration(engine.entries(), JIRA_RECOGNIZER);
  assert.equal(pick.chosen.name, "claude.ai Atlassian");
  assert.equal(pick.alternatives.length, 2);
});

test("pending servers: asked again until they settle", async (t) => {
  const { inventory, claude } = setup(t, { claudeEnv: { FAKE_CLAUDE_MCP_PENDING_REPLIES: "2" } });
  const engine = inventory({}, [claude]);
  await engine.scan();
  const v1 = engine.entries().find((entry) => entry.name === "claude.ai Atlassian");
  assert.equal(v1?.status, "connected");
  assert.equal(v1?.tools?.length, 41);
});

test("pending servers past the settle time are kept as pending, never as a verdict", async (t) => {
  const { inventory, claude } = setup(t, { claudeEnv: { FAKE_CLAUDE_MCP_PENDING_REPLIES: "1000" }, settleMs: 200 });
  const engine = inventory({}, [claude]);
  const [result] = await engine.scan();
  assert.equal(result.ok, true);
  const v1 = engine.entries().find((entry) => entry.name === "claude.ai Atlassian");
  assert.equal(v1?.status, "pending");
  assert.equal(pickIntegration(engine.entries(), JIRA_RECOGNIZER)[0].status, "unknown");
});

test("a CLI that never answers: the scan times out and what was known before stays", async (t) => {
  const { inventory, claude } = setup(t, { claudeEnv: { FAKE_CLAUDE_MCP_STATUS_HANG: "1" } });
  const known: McpInventoryEntry = { runtimeId: "claude", name: "claude.ai Atlassian", scope: "claudeai", transport: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp" }, status: "connected", authMode: "claudeai", scannedAt: 1 };
  const engine = inventory({ initial: [known], requestTimeoutMs: 300 }, [claude]);
  const [result] = await engine.scan();
  assert.deepEqual(result, { runtimeId: "claude", ok: false, error: "timeout" });
  assert.deepEqual(engine.entries(), [known]);
});

test("Codex: a static scan keeps what the last live read learned; a live read of starting servers reports them pending", async (t) => {
  const { inventory, codex } = setup(t, { codexEnv: { FAKE_CODEX_MCP_PENDING_REPLIES: "1" } });
  const engine = inventory({}, [codex]);
  await engine.scan();
  assert.ok(engine.entries().every((entry) => entry.status === "pending" || entry.name === "atlassian"));
  await engine.scan();
  assert.equal(engine.entries().find((entry) => entry.name === "jira-local")?.status, "connected");
  await engine.scan({ tier: "static" });
  assert.equal(engine.entries().find((entry) => entry.name === "jira-local")?.status, "connected");
  assert.equal(engine.entries().find((entry) => entry.name === "atlassian")?.status, "needs_auth");
});

test("Codex not installed: the scan fails without throwing", async (t) => {
  const { dir, inventory, codex } = setup(t);
  const missing = { ...codex, identity: { ...codex.identity, bin: join(dir, "no-such-codex") } };
  const engine = inventory({}, [missing]);
  const [result] = await engine.scan({ tier: "static" });
  assert.deepEqual(result, { runtimeId: "codex", ok: false, error: "unavailable" });
});

test("overlapping scans of one CLI and folder never run at once: the second runs once after the first", async (t) => {
  const { inventory, claude, claudeInvocations } = setup(t);
  const engine = inventory({}, [claude]);
  await Promise.all([engine.scan(), engine.scan(), engine.scan()]);
  assert.equal(claudeInvocations().length, 2);
});

test("in band: a turn's needs-auth is applied to the known server; an unknown server makes it rescan", async (t) => {
  const { inventory, claude, claudeInvocations } = setup(t);
  const engine = inventory({}, [claude]);
  await engine.scan();
  const changes: McpInventoryEntry[][] = [];
  engine.subscribe((entries) => changes.push(entries));
  engine.noteInBand("claude", [{ name: "sentry", status: "needs_auth" }]);
  assert.equal(engine.entries().find((entry) => entry.name === "sentry")?.status, "needs_auth");
  assert.equal(changes.length, 1);
  engine.noteInBand("claude", [{ name: "sentry", status: "pending" }]);
  assert.equal(changes.length, 1);
  engine.noteInBand("claude", [{ name: "brand-new", status: "needs_auth" }]);
  await waitFor(() => claudeInvocations().length === 2);
});

test("watched config: a server change in ~/.claude.json rescans; a counter rewritten in it does not", async (t) => {
  const { home, claudeStatus, inventory, claude, claudeInvocations } = setup(t);
  const claudeJson = join(home, ".claude.json");
  const write = (value: unknown) => {
    // The CLI writes by tmp+rename, which is why the folder is watched.
    writeFileSync(`${claudeJson}.tmp`, JSON.stringify(value));
    renameSync(`${claudeJson}.tmp`, claudeJson);
  };
  write({ numStartups: 1, mcpServers: {} });
  const engine = inventory({}, [claude]);
  await engine.scan();
  engine.start();
  await new Promise((r) => setTimeout(r, 150));

  write({ numStartups: 2, mcpServers: {} });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(claudeInvocations().length, 1);

  const added = { name: "jira", status: "connected", config: { type: "http", url: "https://acme.atlassian.net/mcp" }, scope: "user", source: "user" };
  writeFileSync(claudeStatus, JSON.stringify({ mcpServers: [...CLAUDE_MCP_STATUS_SETTLED.mcpServers, added] }));
  const seen = new Promise<McpInventoryEntry[]>((resolveSeen) => engine.subscribe(resolveSeen));
  write({ numStartups: 3, mcpServers: { jira: { type: "http", url: "https://acme.atlassian.net/mcp" } } });
  const entries = await seen;
  assert.ok(entries.some((entry) => entry.name === "jira" && entry.scope === "user"));
  assert.equal(claudeInvocations().length, 2);
});

test("watched project: a new .mcp.json in a scanned project folder rescans that folder", async (t) => {
  const { project, inventory, claude, claudeInvocations } = setup(t);
  const engine = inventory({}, [claude]);
  engine.start();
  await engine.scan({ cwd: project });
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } }));
  await waitFor(() => claudeInvocations().filter((invocation) => invocation.cwd === project).length === 2);
});

test("static Claude tier: the needs-auth cache marks known servers whose state is not known yet", async (t) => {
  const { home, inventory, claude } = setup(t);
  writeFileSync(join(home, ".claude", "mcp-needs-auth-cache.json"), JSON.stringify({ "claude.ai Atlassian MCP": { timestamp: 1 } }));
  const unknown: McpInventoryEntry = { runtimeId: "claude", name: "claude.ai Atlassian MCP", scope: "claudeai", transport: { type: "claudeai-proxy" }, status: "unknown", authMode: "claudeai", scannedAt: 1 };
  const connected: McpInventoryEntry = { ...unknown, name: "sentry", scope: "user", status: "connected" };
  const engine = inventory({ initial: [unknown, connected] }, [claude]);
  await engine.scan({ tier: "static" });
  assert.deepEqual(
    engine.entries().map((entry) => [entry.name, entry.status]),
    [
      ["claude.ai Atlassian MCP", "needs_auth"],
      ["sentry", "connected"],
    ],
  );
});
