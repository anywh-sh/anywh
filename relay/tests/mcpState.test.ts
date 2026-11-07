// A session's MCP servers against the real relay: its `mcp_state` on every
// connection (only the servers of a known integration), what a turn's own
// stream says about them (Claude's `system`/`init`, Codex's startup status
// push), and a tool call its server failed for want of a sign-in — named on
// the `tool_ended` and signing the server out for the whole profile. Only
// the CLIs are faked (fixtures/fake-claude.mjs, fake-codex-app-server.mjs,
// answering Atlassian's tools from fake-atlassian.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { IntegrationRuntime, McpStateMessage } from "../src/integrations/types.js";
import { CODEX_MCP_STATUS_LIST } from "../src/integrations/inventory/fixtures.js";
import { FAKE_JIRA_SITE, fakeJiraEnv, jiraOf, mcpCallMarker, openRecorded } from "./helpers/fakeJira.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { isTurnEnded } from "./helpers/wsClient.js";

const relays: SpawnedServer[] = [];
const works: string[] = [];
const sockets: WebSocket[] = [];

after(async () => {
  for (const socket of sockets) socket.close();
  for (const relay of relays) {
    relay.proc.kill("SIGTERM");
    await relay.waitForExit();
    relay.cleanup();
  }
  for (const work of works) rmSync(work, { recursive: true, force: true });
});

/** A relay whose profile has Jira (claude.ai Atlassian connected, Codex's
 * Atlassian not signed in), scanned once by a watcher of its integrations. */
async function start(extra: (work: string) => Record<string, string> = () => ({})) {
  const work = mkdtempSync(join(tmpdir(), "anywh-mcp-state-it-"));
  works.push(work);
  const env = { ...fakeJiraEnv(work), FAKE_ATLASSIAN_MODE_FILE: join(work, "atlassian-mode"), ...extra(work) };
  const relay = await spawnRelay(env);
  relays.push(relay);
  const watch = await openRecorded(relay.port, "/integrations/watch");
  sockets.push(watch.socket);
  await watch.recorded.waitFor((message) => runtimeOf(message, "claude")?.status === "connected" && runtimeOf(message, "codex") !== undefined, 0, 30_000);
  return { relay, watch, work, env };
}

const runtimeOf = (message: Record<string, unknown>, runtimeId: string): IntegrationRuntime | undefined => jiraOf(message)?.runtimes.find((runtime) => runtime.runtimeId === runtimeId);
const isMcpState = (message: Record<string, unknown>): message is McpStateMessage & Record<string, unknown> => message.type === "mcp_state";
const serverIn = (message: Record<string, unknown>, name: string) => (isMcpState(message) ? message.servers.find((server) => server.name === name) : undefined);

async function session(port: number, id: string) {
  const opened = await openRecorded(port, `/?session=${id}`);
  sockets.push(opened.socket);
  await opened.recorded.waitFor((message) => message.type === "caught_up");
  return opened;
}

async function turn(chat: Awaited<ReturnType<typeof session>>, text: string): Promise<Record<string, unknown>[]> {
  const since = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "user_message", text }));
  await chat.recorded.waitFor(isTurnEnded, since, 20_000);
  return chat.recorded.messages.slice(since);
}

const toolEnded = (messages: Record<string, unknown>[]) =>
  messages.map((message) => message.event as { type?: string; isError?: boolean; mcpFailure?: unknown } | undefined).find((event) => event?.type === "tool_ended");

test("a session's mcp_state lists its integration servers on every connection, and follows what a turn's init says", async () => {
  const initFile = (work: string) => join(work, "init-mcp-servers.json");
  const { relay, watch, work } = await start((dir) => ({ FAKE_CLAUDE_INIT_MCP_SERVERS_FILE: initFile(dir) }));
  const chat = await session(relay.port, "s-init");
  const first = chat.recorded.messages.find(isMcpState);
  assert.ok(first, "sent on connecting, before the history");
  assert.equal(first.runtimeId, "claude");
  assert.deepEqual(serverIn(first, "claude.ai Atlassian"), { name: "claude.ai Atlassian", status: "connected", integrationId: "jira", canLogin: true });
  assert.equal(serverIn(first, "claude.ai Atlassian MCP")?.status, "needs_auth");
  assert.equal(serverIn(first, "claude.ai Notion"), undefined, "a server of no integration stays out");
  assert.ok(chat.recorded.messages.indexOf(first) < chat.recorded.messages.findIndex((message) => message.type === "caught_up"));

  // The CLI's own cache says the connector needs a sign-in now.
  writeFileSync(initFile(work), JSON.stringify([{ name: "claude.ai Atlassian", status: "needs-auth", source: "claudeai" }, { name: "claude.ai Notion", status: "needs-auth" }]));
  const since = chat.recorded.mark();
  const watchSince = watch.recorded.mark();
  await turn(chat, "hello");
  // The device already there is told...
  await chat.recorded.waitFor((message) => serverIn(message, "claude.ai Atlassian")?.status === "needs_auth", since);
  // ...the profile's integration too...
  await watch.recorded.waitFor((message) => runtimeOf(message, "claude")?.status === "needs_auth", watchSince);
  // ...and every device that connects from now on.
  const later = await session(relay.port, "s-init");
  assert.equal(serverIn(later.recorded.messages.find(isMcpState) ?? {}, "claude.ai Atlassian")?.status, "needs_auth");
  // Another session of the profile has the same server.
  const other = await session(relay.port, "s-other");
  assert.equal(serverIn(other.recorded.messages.find(isMcpState) ?? {}, "claude.ai Atlassian")?.status, "needs_auth");
});

test("a call its server refused for an expired sign-in names the server and signs it out; Codex's startup push signs one in", async () => {
  const codexStatus = (work: string) => join(work, "codex-mcp-status.json");
  const { relay, watch, work } = await start(() => ({ FAKE_CODEX_STARTUP_STATUS: "1" }));
  writeFileSync(join(work, "atlassian-mode"), "unauthorized");

  // Claude: the 401 mid-session leaves the CLI calling the server connected.
  const chat = await session(relay.port, "s-claude");
  const since = chat.recorded.mark();
  const watchSince = watch.recorded.mark();
  const messages = await turn(chat, `look ${mcpCallMarker("claude_ai_Atlassian", "getJiraIssue", { cloudId: FAKE_JIRA_SITE.id, issueIdOrKey: "NGL-1" })}`);
  const ended = toolEnded(messages);
  assert.equal(ended?.isError, true);
  assert.deepEqual(ended?.mcpFailure, { server: "claude.ai Atlassian", reason: "auth" }, "by the name the profile knows it");
  await chat.recorded.waitFor((message) => serverIn(message, "claude.ai Atlassian")?.status === "needs_auth", since);
  await watch.recorded.waitFor((message) => runtimeOf(message, "claude")?.status === "needs_auth", watchSince);

  // Codex: the server got its login since the last scan; the session's
  // thread start pushes that, with no scan.
  writeFileSync(
    codexStatus(work),
    JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name !== "jira-local").map((server) => (server.name === "atlassian" ? { ...server, runtimeStatus: "connected", authStatus: "oAuth" } : server)) }),
  );
  const codex = await session(relay.port, "s-codex");
  const agentSince = codex.recorded.mark();
  codex.socket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));
  await codex.recorded.waitFor((message) => message.type === "agent_state" && message.agentId === "codex", agentSince);
  await codex.recorded.waitFor((message) => isMcpState(message) && message.runtimeId === "codex", agentSince);
  const codexSince = codex.recorded.mark();
  const codexWatchSince = watch.recorded.mark();
  const first = await turn(codex, "hello");
  assert.ok(first.length > 0);
  await watch.recorded.waitFor((message) => runtimeOf(message, "codex")?.status === "connected", codexWatchSince);
  await codex.recorded.waitFor((message) => serverIn(message, "atlassian")?.status === "connected", codexSince);

  // ...and its call, answered with the server's 401, signs it out again.
  const afterLogin = watch.recorded.mark();
  const codexMessages = await turn(codex, `look ${mcpCallMarker("atlassian", "getJiraIssue", { cloudId: FAKE_JIRA_SITE.id, issueIdOrKey: "NGL-1" })}`);
  const codexEnded = toolEnded(codexMessages);
  assert.equal(codexEnded?.isError, true);
  assert.deepEqual(codexEnded?.mcpFailure, { server: "atlassian", reason: "auth" });
  await watch.recorded.waitFor((message) => runtimeOf(message, "codex")?.status === "needs_auth", afterLogin);
});
