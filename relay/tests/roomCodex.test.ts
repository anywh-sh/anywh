// A room whose principal is Codex, against the fake `codex app-server`
// (tests/fixtures/fake-codex-app-server.mjs, speaking the codex-cli 0.154.0
// shapes recorded in codex-app-server-0.154.0-dynamic-tools.json). No real
// Codex ran for any of this: it pins the wiring — the room tools declared as
// dynamic tools, the `item/tool/call` routed through the agent host to the
// relay's room endpoint, the principal kept read-only and off Codex's own
// subagents — and that a Codex without dynamic tools fails visibly, never
// swapping the principal for another agent.
//
// The relay is a real separate process; the agent host runs in this test's
// process so its Codex def can point at the fake.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "../src/agentHost/agentHost.js";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { codexRuntimeDef } from "../src/runtimes/defs/codex.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { FAKE_AGENT_BIN } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const FAKE_CODEX = resolve(import.meta.dirname, "fixtures/fake-codex-app-server.mjs");

let dir: string;
let host: AgentHost;
let relay: SpawnedServer;
let base: string;
let requestsFile: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-room-codex-"));
  const home = join(dir, "home");
  mkdirSync(home);
  requestsFile = join(dir, "codex-requests.jsonl");
  // `codex` on the relay's PATH is the fake too, so the relay counts Codex
  // as installed (its `--version` answers) wherever this runs.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  host = await AgentHost.start({
    hostId: `codex-room-${process.pid}`,
    dataDir: join(dir, "data"),
    socketPath: join(dir, "run", "host.sock"),
    agentBin: FAKE_AGENT_BIN,
    homeOverride: home,
    drainGraceMs: 300,
    codexDef: { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin: FAKE_CODEX, env: { ...codexRuntimeDef.identity.env, set: { FAKE_CODEX_REQUESTS: requestsFile } } } },
  });
  // EXTRA_PATH_DIRS emptied: inherited from a shell, it can put a real
  // `codex` ahead of the fake on the relay's children's PATH.
  relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath, PATH: `${bin}:${process.env.PATH ?? ""}`, EXTRA_PATH_DIRS: "" });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`)).status === 200, "relay connected to the host");
  await waitFor(async () => {
    const info = (await (await fetch(`${base}/host-info`)).json()) as { agents?: { id: string }[] };
    return info.agents?.some((agent) => agent.id === "codex") === true;
  }, "Codex detected");
});

after(async () => {
  relay?.cleanup();
  await host?.close({ drainGraceMs: 100 });
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-3000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

async function createCodexRoom(cwd: string): Promise<string> {
  const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "codex", model: "gpt-fake", cwd, permissionMode: "full-access" }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { roomId: string }).roomId;
}

async function turn(roomId: string, text: string): Promise<Record<string, unknown>[]> {
  const socket = await connectSession(relay.port, roomId);
  try {
    // A failed turn ends with an error and an idle turn_state, no turn_ended.
    let started = false;
    const done = collectUntil(
      socket,
      (message) => {
        if (message.type === "turn_state" && message.active === true) started = true;
        return isTurnEnded(message) || (started && message.type === "turn_state" && message.active === false);
      },
      30_000,
    );
    sendUserMessage(socket, text);
    return (await done).filter((message) => message.type === "agent_event").map((message) => message.event as Record<string, unknown>);
  } finally {
    socket.close();
  }
}

function codexRequests(): { method: string; params: Record<string, unknown> }[] {
  if (!existsSync(requestsFile)) return [];
  return readFileSync(requestsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

test("a Codex principal delegates through its dynamic tools; the worker is born in the host and reports", async () => {
  const roomId = await createCodexRoom(dir);
  const report = `[[room:report:${b64({ status: "done", summary: "done from a claude worker", artifacts: [] })}]]`;
  const events = await turn(roomId, `[[tool:delegate:${b64({ task: `check the build ${report}`, runtime: "claude", model: "haiku" })}]]`);

  const started = events.find((event) => event.type === "tool_started");
  assert.deepEqual(started?.subject, { kind: "mcp", server: "anywh-room", tool: "delegate" }, "shown like the Claude principal's call");
  const ended = events.find((event) => event.type === "tool_ended");
  assert.equal(ended?.isError, false, String(ended?.content));
  const { agentId } = JSON.parse(String(ended?.content)) as { agentId: string };

  await waitFor(async () => {
    const room = (await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string; agentId: string; room: { report?: { summary: string }; undeliveredReports?: string[] } }[] };
    return room.members.find((member) => member.id === agentId)?.room.report?.summary === "done from a claude worker";
  }, "the worker's report");
  const room = (await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string; agentId: string; room: { undeliveredReports?: string[] } }[] };
  assert.equal(room.members.find((member) => member.id === roomId)?.agentId, "codex");
  assert.deepEqual(room.members.find((member) => member.id === roomId)?.room.undeliveredReports, [agentId]);
  const agents = ((await (await fetch(`${base}/agents/activity`)).json()) as { agents: AgentActivity[] }).agents;
  assert.equal(agents.find((agent) => agent.agentId === roomId)?.runtime, "codex");
  assert.equal(agents.find((agent) => agent.agentId === agentId)?.runtime, "claude");

  const threadStart = codexRequests().find((request) => request.method === "thread/start" && request.params.cwd === dir)!;
  assert.deepEqual(
    (threadStart.params.dynamicTools as { name: string }[]).map((tool) => tool.name),
    ["delegate", "message_agent", "stop_agent", "room_status"],
  );
  assert.deepEqual(threadStart.params.config, { features: { multi_agent: false }, web_search: "disabled" }, "Codex's own subagents and web search are off for the principal");
  const turnStart = codexRequests().find((request) => request.method === "turn/start")!;
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false }, "read-only although the room was opened in full-access");
  assert.equal(turnStart.params.approvalPolicy, "never");
});

test("a Codex without dynamic tools fails visibly in the principal's chat, and the room stays on Codex", async () => {
  const cwd = join(dir, "without-dynamic-tools");
  mkdirSync(cwd);
  const roomId = await createCodexRoom(cwd);
  const events = await turn(roomId, `[[tool:delegate:${b64({ task: "x", runtime: "claude", model: "haiku" })}]]`);
  const error = events.find((event) => event.type === "error");
  assert.ok(error, JSON.stringify(events));
  assert.match(String(error.message), /room's tools are not available with this version of Codex/);
  assert.match(String(error.message), /nothing was switched to another agent/);
  const room = (await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: { id: string; agentId: string }[] };
  assert.deepEqual(room.members.map((member) => [member.id, member.agentId]), [[roomId, "codex"]], "still Codex, and nothing was delegated");
  const agents = ((await (await fetch(`${base}/agents/activity`)).json()) as { agents: AgentActivity[] }).agents;
  assert.equal(agents.some((agent) => agent.agentId === roomId && agent.runtime !== "codex"), false, "no other runtime took its place");
});

test("a Codex thread that fails for another reason says that reason, not that the room tools are missing", async () => {
  const cwd = join(dir, "thread-start-fails");
  mkdirSync(cwd);
  const roomId = await createCodexRoom(cwd);
  const events = await turn(roomId, "hello");
  const error = events.find((event) => event.type === "error");
  assert.ok(error, JSON.stringify(events));
  assert.match(String(error.message), /not logged in/);
  assert.doesNotMatch(String(error.message), /room's tools are not available/);
});

test("a Codex agent has no native subtasks to stop: listed empty, and stopping one is a 409", async () => {
  const roomId = await createCodexRoom(dir);
  await turn(roomId, "hello");
  const url = `${base}/rooms/${roomId}/agents/${roomId}/subtasks`;
  assert.deepEqual(((await (await fetch(url)).json()) as { subtasks: unknown[] }).subtasks, []);
  assert.equal((await fetch(`${url}/task-1/stop`, { method: "POST" })).status, 409);
});
