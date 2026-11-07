// Signing a profile's agent CLIs in to their MCP servers from the app,
// against the real relay over /integrations/watch: "+ Add Jira" declares the
// server in each CLI and queues one sign-in per CLI, a callback of another
// sign-in is refused, the app's `anywh://` link completes each (Codex's
// delivered to its own loopback listener), the sessions' processes load the
// token and the integration shows connected. Then the edges: a sign-in
// nobody finishes, a server that refuses the app's link (loopback + paste),
// and a claude.ai connector checked again. Only the CLIs are faked
// (fixtures/fake-claude.mjs, fake-codex-app-server.mjs): no OAuth server is
// contacted — the fakes answer the sign-in requests with their recorded
// shapes, and the CLI's real behaviour is the conformance tier's
// (tests/conformance/).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } from "../src/integrations/inventory/fixtures.js";
import type { IntegrationRuntime, McpAuthFlow } from "../src/integrations/types.js";
import { fakeJiraEnv, jiraOf, openRecorded } from "./helpers/fakeJira.js";
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

type Prepare = (files: { claudeStatus: string; codexList: string; codexStatus: string }) => void;

/** `scanned`: what the first scan shows once it is in (none: nothing to
 * wait for — the add rescans by itself). */
async function start(prepare: Prepare, extra: Record<string, string> = {}, scanned?: (message: Record<string, unknown>) => boolean) {
  const work = mkdtempSync(join(tmpdir(), "anywh-mcp-auth-it-"));
  works.push(work);
  const files = { claudeStatus: join(work, "claude-mcp-status.json"), codexList: join(work, "codex-mcp-list.json"), codexStatus: join(work, "codex-mcp-status.json") };
  const env = { ...fakeJiraEnv(work), FAKE_CLAUDE_CONTROL_FILE: join(work, "claude-control.jsonl"), FAKE_CODEX_RELOADS_FILE: join(work, "codex-reloads.jsonl"), ...extra };
  prepare(files);
  const relay = await spawnRelay(env);
  relays.push(relay);
  const watch = await openRecorded(relay.port, "/integrations/watch");
  sockets.push(watch.socket);
  if (scanned) await watch.recorded.waitFor(scanned, 0, 30_000);
  return { relay, watch, work, files };
}

const runtimeOf = (message: Record<string, unknown>, runtimeId: string): IntegrationRuntime | undefined => jiraOf(message)?.runtimes.find((runtime) => runtime.runtimeId === runtimeId);
const flowOf = (runtimeId: string, serverName: string, phase?: McpAuthFlow["phase"]) => (message: Record<string, unknown>) =>
  message.type === "mcp_auth_flow" && message.runtimeId === runtimeId && message.serverName === serverName && (phase === undefined || message.phase === phase);
const asFlow = (message: Record<string, unknown>) => message as unknown as McpAuthFlow;
const redirectOf = (flow: McpAuthFlow) => new URL(flow.authUrl ?? "").searchParams.get("redirect_uri") ?? "";
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []);

test("+ Add Jira declares it in both CLIs, signs each in through the app's link in turn, and the sessions' processes load the tokens", async () => {
  // A profile with no Jira anywhere.
  const { relay, watch, work } = await start((files) => {
    writeFileSync(files.claudeStatus, JSON.stringify({ mcpServers: CLAUDE_MCP_STATUS_SETTLED.mcpServers.filter((server) => !/atlassian/i.test(server.name)) }));
    writeFileSync(files.codexList, JSON.stringify((JSON.parse(CODEX_MCP_LIST_STDOUT) as { name: string }[]).filter((server) => server.name === "deepwiki")));
    writeFileSync(files.codexStatus, JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name === "deepwiki") }));
  });
  assert.deepEqual(jiraOf(await watch.recorded.waitFor((message) => message.type === "integrations_state"))?.runtimes, []);

  // A live Codex session: its own app-server must load the new token.
  const chat = await openRecorded(relay.port, "/?session=s-codex");
  sockets.push(chat.socket);
  const cwd = ((await chat.recorded.waitFor((message) => message.type === "cwd_state")) as { cwd: string }).cwd;
  await chat.recorded.waitFor((message) => message.type === "caught_up");
  chat.socket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));
  await chat.recorded.waitFor((message) => message.type === "agent_state" && message.agentId === "codex");
  const turnSince = chat.recorded.mark();
  chat.socket.send(JSON.stringify({ type: "user_message", text: "hello" }));
  await chat.recorded.waitFor(isTurnEnded, turnSince, 20_000);

  const since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "integration_add", id: "jira", provider: "jira", runtimes: ["claude", "codex"] }));
  const claudeFlow = asFlow(await watch.recorded.waitFor(flowOf("claude", "atlassian", "awaiting_user"), since, 30_000));
  assert.equal(claudeFlow.mode, "deeplink");
  assert.equal(redirectOf(claudeFlow), "anywh://mcp-oauth/callback");
  assert.ok(claudeFlow.state && new URL(claudeFlow.authUrl ?? "").searchParams.get("state") === claudeFlow.state);
  const codexQueued = asFlow(await watch.recorded.waitFor(flowOf("codex", "atlassian"), since));
  assert.equal(codexQueued.phase, "queued", "one sign-in at a time");

  // A callback of another sign-in is refused; the flow keeps waiting.
  const wrongSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_complete", flowId: claudeFlow.flowId, callbackUrl: "anywh://mcp-oauth/callback?code=c1&state=not-this-one" }));
  const refused = asFlow(await watch.recorded.waitFor((message) => flowOf("claude", "atlassian")(message) && message.error === "state_mismatch", wrongSince));
  assert.equal(refused.phase, "awaiting_user");
  assert.ok(!lines(join(work, "claude-control.jsonl")).some((line) => line.subtype === "mcp_oauth_callback_url"), "nothing reached the CLI");

  watch.socket.send(JSON.stringify({ type: "mcp_auth_complete", flowId: claudeFlow.flowId, callbackUrl: `anywh://mcp-oauth/callback?code=c1&state=${claudeFlow.state}` }));
  await watch.recorded.waitFor(flowOf("claude", "atlassian", "done"), wrongSince, 20_000);
  const subtypes = lines(join(work, "claude-control.jsonl")).filter((line) => line.serverName === "atlassian").map((line) => line.subtype);
  assert.deepEqual(subtypes.slice(0, 3), ["mcp_authenticate", "mcp_oauth_callback_url", "mcp_reconnect"], "the token is loaded in the sign-in's process before it says done");

  // Codex next: the app's link, with the listener's path appended.
  const codexFlow = asFlow(await watch.recorded.waitFor(flowOf("codex", "atlassian", "awaiting_user"), since, 20_000));
  assert.equal(codexFlow.flowId, codexQueued.flowId);
  assert.match(redirectOf(codexFlow), /^anywh:\/\/mcp-oauth\/callback\/[a-z0-9]+$/);
  const doneSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_complete", flowId: codexFlow.flowId, callbackUrl: `${redirectOf(codexFlow)}?code=c2&state=${codexFlow.state}` }));
  await watch.recorded.waitFor(flowOf("codex", "atlassian", "done"), doneSince, 20_000);

  // Both CLIs show signed in, after a fresh look at their servers.
  await watch.recorded.waitFor((message) => runtimeOf(message, "claude")?.status === "connected" && runtimeOf(message, "codex")?.status === "connected", doneSince, 30_000);
  // The session's app-server (the one with a thread in its folder) reloaded.
  const reloadDeadline = Date.now() + 10_000;
  while (!lines(join(work, "codex-reloads.jsonl")).some((line) => (line.cwds as string[]).includes(cwd)) && Date.now() < reloadDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(lines(join(work, "codex-reloads.jsonl")).some((line) => (line.cwds as string[]).includes(cwd)), "the live session's daemon was told to reload");

  // A device that connects now sees how the sign-ins ended.
  const later = await openRecorded(relay.port, "/integrations/watch");
  sockets.push(later.socket);
  await later.recorded.waitFor(flowOf("codex", "atlassian", "done"));
});

test("a sign-in nobody finishes fails; a server that refuses the app's link signs in on loopback with the pasted address; a claude.ai connector is checked again", async () => {
  const { watch, files } = await start(
    (paths) => {
      writeFileSync(
        paths.claudeStatus,
        JSON.stringify({ mcpServers: [...CLAUDE_MCP_STATUS_SETTLED.mcpServers.filter((server) => server.name === "claude.ai Atlassian MCP"), { name: "atlassian", status: "needs-auth", scope: "user", source: "user", config: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } }] }),
      );
      writeFileSync(paths.codexList, JSON.stringify((JSON.parse(CODEX_MCP_LIST_STDOUT) as { name: string }[]).filter((server) => server.name === "atlassian")));
      writeFileSync(paths.codexStatus, JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name === "atlassian") }));
    },
    { ANYWH_MCP_AUTH_TIMEOUT_MS: "4000", ANYWH_MCP_AUTH_RECHECK_WINDOW_MS: "1000", FAKE_CODEX_REJECT_CUSTOM_REDIRECT: "1" },
    (message) => runtimeOf(message, "claude") !== undefined && runtimeOf(message, "codex") !== undefined,
  );

  // Nobody comes back from the browser.
  const since = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_start", targets: [{ runtimeId: "claude", serverName: "atlassian" }] }));
  await watch.recorded.waitFor(flowOf("claude", "atlassian", "awaiting_user"), since, 15_000);
  const failed = asFlow(await watch.recorded.waitFor(flowOf("claude", "atlassian", "failed"), since, 15_000));
  assert.equal(failed.error, "timeout");

  // The server would not register the app's link: loopback, and the
  // address the browser ended on pasted back.
  const codexSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_start", targets: [{ runtimeId: "codex", serverName: "atlassian" }], mode: "deeplink" }));
  const loopback = asFlow(await watch.recorded.waitFor(flowOf("codex", "atlassian", "awaiting_user"), codexSince, 15_000));
  assert.equal(loopback.mode, "localhost");
  assert.match(redirectOf(loopback), /^http:\/\/127\.0\.0\.1:\d+\/callback\/[a-z0-9]+$/);
  watch.socket.send(JSON.stringify({ type: "mcp_auth_complete", flowId: loopback.flowId, callbackUrl: `${redirectOf(loopback)}?code=c3&state=${loopback.state}` }));
  await watch.recorded.waitFor(flowOf("codex", "atlassian", "done"), codexSince, 15_000);
  await watch.recorded.waitFor((message) => runtimeOf(message, "codex")?.status === "connected", codexSince, 30_000);

  // A claude.ai connector is authorized on claude.ai, then looked at again.
  const connectorSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_start", targets: [{ runtimeId: "claude", serverName: "claude.ai Atlassian MCP" }] }));
  const connector = asFlow(await watch.recorded.waitFor(flowOf("claude", "claude.ai Atlassian MCP", "awaiting_user"), connectorSince, 15_000));
  assert.equal(connector.mode, "claudeai");
  assert.match(connector.authUrl ?? "", /^https:\/\/claude\.ai\/api\/organizations\/[^/]+\/mcp\/start-auth\//);
  assert.equal(connector.state, undefined);
  const recheckSince = watch.recorded.mark();
  watch.socket.send(JSON.stringify({ type: "mcp_auth_recheck", flowId: connector.flowId }));
  await watch.recorded.waitFor((message) => flowOf("claude", "claude.ai Atlassian MCP", "awaiting_user")(message) && message.error === "not_authorized", recheckSince, 15_000);
  // Authorized on claude.ai meanwhile.
  const status = JSON.parse(readFileSync(files.claudeStatus, "utf8")) as { mcpServers: { name: string; status: string }[] };
  writeFileSync(files.claudeStatus, JSON.stringify({ mcpServers: status.mcpServers.map((server) => (server.name === "claude.ai Atlassian MCP" ? { ...server, status: "connected" } : server)) }));
  watch.socket.send(JSON.stringify({ type: "mcp_auth_recheck", flowId: connector.flowId }));
  await watch.recorded.waitFor(flowOf("claude", "claude.ai Atlassian MCP", "done"), recheckSince, 15_000);
});
