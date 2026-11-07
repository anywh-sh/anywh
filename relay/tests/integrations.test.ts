// /integrations/watch against the real relay, run as its own process so it
// can be restarted on the same files: the fake `claude` answers `mcp_status`
// with the recorded inventory (claude.ai Atlassian connected) and `mcp_call`
// with the Atlassian replies of fixtures/fake-atlassian.mjs, and a `codex`
// wrapper on the PATH runs the fake app-server, whose official Atlassian
// server has no login — so reads go through Claude. Proves the wiring —
// inventory → service → socket, refresh → tool call → cache, prefs → disk →
// the next relay — never the CLIs' behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type WebSocket from "ws";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "../src/integrations/inventory/fixtures.js";
import type { IntegrationState } from "../src/integrations/types.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { collectUntil, connectIntegrationsWatchAndCollectUntil } from "./helpers/wsClient.js";

const FAKE_CODEX = resolve(import.meta.dirname, "fixtures/fake-codex-app-server.mjs");

const work = mkdtempSync(join(tmpdir(), "anywh-integrations-it-"));
const home = join(work, "home");
const binDir = join(work, "bin");
const sessionsFile = join(work, "sessions.json");
const stateFile = join(work, "sessions-integrations.json");
const files = {
  claudeStatus: join(work, "claude-mcp-status.json"),
  codexList: join(work, "codex-mcp-list.json"),
  codexStatus: join(work, "codex-mcp-status.json"),
  atlassianCalls: join(work, "atlassian-calls.jsonl"),
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let relay: SpawnedServer | undefined;
let env: Record<string, string>;

before(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir);
  // The fake claude runs through `#!/usr/bin/env node`: this test's node goes
  // first, since a directory holding a real `codex` is dropped below.
  symlinkSync(process.execPath, join(binDir, "node"));
  writeFileSync(join(binDir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  chmodSync(join(binDir, "codex"), 0o755);
  writeFileSync(files.claudeStatus, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  // Only the official server: the community one would be picked for Codex
  // (connected), which is not what this test is about.
  writeFileSync(files.codexList, JSON.stringify((JSON.parse(CODEX_MCP_LIST_STDOUT) as { name: string }[]).filter((server) => server.name !== "jira-local")));
  writeFileSync(files.codexStatus, JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name !== "jira-local") }));
  const inheritedPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !isExecutable(join(entry, "codex")));
  env = {
    // The relay looks for agent CLIs in a few per-user folders under $HOME
    // too: never the real one's.
    HOME: home,
    RELAY_HOME_OVERRIDE: home,
    RELAY_SESSIONS_FILE: sessionsFile,
    PATH: [binDir, ...inheritedPath].join(delimiter),
    EXTRA_PATH_DIRS: "",
    FAKE_CLAUDE_MCP_STATUS_FILE: files.claudeStatus,
    FAKE_CODEX_MCP_LIST_FILE: files.codexList,
    FAKE_CODEX_MCP_STATUS_FILE: files.codexStatus,
    FAKE_ATLASSIAN_CALLS_FILE: files.atlassianCalls,
    // Four open tickets of mine in the fixture: two pages.
    FAKE_ATLASSIAN_PAGE_SIZE: "2",
  };
});

after(async () => {
  await stop();
  rmSync(work, { recursive: true, force: true });
});

async function start(): Promise<SpawnedServer> {
  relay = await spawnRelay(env);
  return relay;
}

async function stop(): Promise<void> {
  if (!relay) return;
  const current = relay;
  relay = undefined;
  current.proc.kill("SIGTERM");
  await current.waitForExit();
  current.cleanup();
}

type StateMessage = { type: "integrations_state"; integrations: IntegrationState[] };
const isState = (message: Record<string, unknown>): message is Record<string, unknown> & StateMessage => message.type === "integrations_state";
const jiraOf = (message: StateMessage) => message.integrations.find((integration) => integration.id === "jira");
const detected = (message: Record<string, unknown>) => isState(message) && jiraOf(message)?.runtimes.some((runtime) => runtime.runtimeId === "claude" && runtime.status === "connected") === true;

const queryOf = (message: StateMessage, query: "mine" | "ticket", param: string | null) => jiraOf(message)?.queries.find((state) => state.query === query && state.param === param);
const settled = (query: "mine" | "ticket", param: string | null, extra: (state: NonNullable<ReturnType<typeof queryOf>>) => boolean = () => true) => (message: Record<string, unknown>) => {
  if (!isState(message)) return false;
  const state = queryOf(message, query, param);
  return state !== undefined && !state.reading && extra(state);
};
const calls = (): { via: string; tool: string; isolated: boolean; arguments: Record<string, unknown> }[] => {
  try {
    return readFileSync(files.atlassianCalls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { via: string; tool: string; isolated: boolean; arguments: Record<string, unknown> });
  } catch {
    return [];
  }
};
const lastOf = (messages: Record<string, unknown>[]) => messages.at(-1) as unknown as StateMessage;

let socket: WebSocket | undefined;
after(() => socket?.close());

test("the snapshot comes first, without protocol_version, and the scan finds Jira in each CLI", async () => {
  const server = await start();
  const { socket: watch, messages } = await connectIntegrationsWatchAndCollectUntil(server.port, detected, 30_000);
  socket = watch;
  assert.equal(messages[0].type, "integrations_state", "first message is the snapshot");
  assert.ok(!messages.some((message) => message.type === "protocol_version"));
  const jira = jiraOf(messages.at(-1) as unknown as StateMessage);
  assert.ok(jira);
  const claude = jira.runtimes.find((runtime) => runtime.runtimeId === "claude");
  // The other match outside a project: the v2 connector, needing auth.
  assert.deepEqual(claude, { runtimeId: "claude", serverName: "claude.ai Atlassian", scope: "claudeai", status: "connected", authMode: "claudeai", alternatives: 1 });
  assert.equal(jira.fetchRuntime, "claude");
  assert.deepEqual(jira.prefs, { project: null });

  // The Codex scan lands on its own; its official server has no login.
  const withCodex = await collectUntil(
    watch,
    (message) => isState(message) && jiraOf(message)?.runtimes.some((runtime) => runtime.runtimeId === "codex") === true,
    30_000,
  );
  {
    const codex = jiraOf(withCodex.at(-1) as unknown as StateMessage)?.runtimes.find((runtime) => runtime.runtimeId === "codex");
    assert.equal(codex?.serverName, "atlassian");
    assert.equal(codex?.status, "needs_auth");
  }

  watch.send(JSON.stringify({ type: "ping" }));
  await collectUntil(watch, (message) => message.type === "pong", 5000);
});

test("my tickets are read through Claude's own tool call, page by page; ↻ inside the floor is refused", async () => {
  assert.ok(socket);
  socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "mine", param: null, force: false }));
  let state = lastOf(await collectUntil(socket, settled("mine", null, (query) => query.status !== "unknown"), 30_000));
  let mine = queryOf(state, "mine", null);
  assert.ok(mine?.query === "mine");
  assert.equal(mine.status, "ok", JSON.stringify(mine));
  assert.equal(mine.source, "open");
  assert.deepEqual(mine.items?.map((item) => item.key), ["NGL-2", "NGL-1"], "newest change first, done ones left out");
  assert.equal(mine.nextPageToken, "cursor-2");
  assert.ok(typeof mine.refreshableAt === "number");
  assert.deepEqual(jiraOf(state)?.site, { id: "00000000-0000-4000-8000-0000000000a1", url: "https://example-team.atlassian.net", name: "example-team" });
  assert.deepEqual(calls().map((call) => [call.via, call.tool, call.isolated]), [
    ["claude", "getAccessibleAtlassianResources", true],
    ["claude", "searchJiraIssuesUsingJql", true],
  ]);
  assert.equal(calls()[1].arguments.actionSource, "jira_mcp_card");

  socket.send(JSON.stringify({ type: "integration_load_more", id: "jira", query: "mine", param: null }));
  state = lastOf(await collectUntil(socket, settled("mine", null, (query) => query.query === "mine" && (query.items?.length ?? 0) > 2), 15_000));
  mine = queryOf(state, "mine", null);
  assert.ok(mine?.query === "mine");
  assert.deepEqual(mine.items?.map((item) => item.key), ["NGL-2", "NGL-1", "ABC-7", "NGL-4"]);
  assert.equal(mine.nextPageToken, undefined);
  assert.equal(calls().at(-1)?.arguments.nextPageToken, "cursor-2");

  // Pressed right after: answered with the cache and when it may be pressed again.
  const before = calls().length;
  socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "mine", param: null, force: true }));
  state = lastOf(await collectUntil(socket, isState, 5000));
  assert.equal(calls().length, before, "no call made");
  assert.ok((queryOf(state, "mine", null)?.refreshableAt ?? 0) > Date.now());
  assert.equal(queryOf(state, "mine", null)?.source, "open");

  socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "mine", param: "ABC", force: true }));
  state = lastOf(await collectUntil(socket, settled("mine", "ABC", (query) => query.status === "ok"), 15_000));
  const abc = queryOf(state, "mine", "ABC");
  assert.ok(abc?.query === "mine");
  assert.deepEqual(abc.items?.map((item) => item.key), ["ABC-7"]);
  assert.equal(abc.source, "manual");
  assert.match(String(calls().at(-1)?.arguments.jql), /AND project = "ABC" ORDER BY updated DESC$/);
});

test("a ticket screen reads the ticket, its description and latest comments cut to size", async () => {
  assert.ok(socket);
  socket.send(JSON.stringify({ type: "integration_refresh", id: "jira", query: "ticket", param: "NGL-1", force: false }));
  const state = lastOf(await collectUntil(socket, settled("ticket", "NGL-1", (query) => query.status === "ok"), 15_000));
  const ticket = queryOf(state, "ticket", "NGL-1");
  assert.ok(ticket?.query === "ticket" && ticket.detail);
  assert.equal(ticket.detail.title, "Fix the login redirect");
  assert.equal(ticket.detail.statusCategory, "doing");
  assert.equal(ticket.detail.priority, "High");
  assert.ok((ticket.detail.descriptionMd?.length ?? 0) <= 4001);
  assert.equal(ticket.detail.comments.length, 10);
  const call = calls().at(-1);
  assert.equal(call?.tool, "getJiraIssue");
  assert.equal(call?.arguments.updateHistory, false);
  // Only the allowlist was ever called, all through the isolated process.
  assert.deepEqual([...new Set(calls().map((entry) => entry.tool))].sort(), ["getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql"]);
  assert.ok(calls().every((entry) => entry.via === "claude" && entry.isolated));
});

test("integration_prefs is saved, survives a restart of the relay, and a file of another version is dropped", async () => {
  assert.ok(relay && socket);
  socket.send(JSON.stringify({ type: "integration_prefs", id: "jira", prefs: { project: "NGL" } }));
  await collectUntil(socket, (message) => isState(message) && jiraOf(message)?.prefs.project === "NGL", 5000);
  // Not yet served: answered by nothing, and the socket stays up.
  socket.send(JSON.stringify({ type: "work_ticket", sessionId: "s1", action: "unlink" }));
  socket.send(JSON.stringify({ type: "integration_add", id: "jira", provider: "jira", runtimes: ["codex"] }));
  socket.send(JSON.stringify({ type: "ping" }));
  await collectUntil(socket, (message) => message.type === "pong", 5000);
  socket.close();
  socket = undefined;

  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { version: number; integrations: { jira: { prefs: unknown } }; inventory: unknown[] };
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.integrations.jira.prefs, { project: "NGL" });
  assert.ok(saved.inventory.length > 0);

  await stop();
  const restarted = await start();
  const { socket: again, messages } = await connectIntegrationsWatchAndCollectUntil(restarted.port, isState, 15_000);
  const first = messages[0] as unknown as StateMessage;
  assert.deepEqual(jiraOf(first)?.prefs, { project: "NGL" }, "the choice came back from disk");
  assert.equal(jiraOf(first)?.runtimes.find((runtime) => runtime.runtimeId === "claude")?.status, "connected", "and the inventory, before any scan");
  const cached = queryOf(first, "mine", null);
  assert.ok(cached?.query === "mine" && cached.items?.length === 4 && cached.status === "ok" && !cached.reading, "and the last good list");
  again.close();

  await stop();
  writeFileSync(stateFile, JSON.stringify({ ...saved, version: 2 }));
  const third = await start();
  const { socket: fresh, messages: freshMessages } = await connectIntegrationsWatchAndCollectUntil(third.port, isState, 15_000);
  const dropped = freshMessages[0] as unknown as StateMessage;
  assert.deepEqual(jiraOf(dropped)?.prefs, { project: null });
  assert.deepEqual(jiraOf(dropped)?.runtimes, []);
  fresh.close();
});
