// The room's tools end to end, across real processes: the agent host (its
// own service entrypoint) running the fake `claude` in its persistent mode,
// and the real relay serving the `anywh-room` MCP bridge. The fake calls the
// bridge over HTTP exactly where the real CLI would, scripted by markers in
// the message text (fake-claude-persistent.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";
import type { AgentActivity } from "../src/agentHost/protocol.js";
import { hostEnvDir, startHostProcess, type HostProcess } from "./helpers/agentHostProcess.js";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

let host: HostProcess;
let relay: SpawnedServer;
let base: string;
const argvFile = (): string => join(host.dir, "argv.jsonl");

before(async () => {
  const { dir, home } = hostEnvDir();
  host = startHostProcess(dir, home, { FAKE_CLAUDE_ARGV_FILE: join(dir, "argv.jsonl"), FAKE_CLAUDE_ENV_FILE: join(dir, "env.jsonl") });
  relay = await spawnRelay({ ANYWH_AGENT_HOST_SOCKET: host.socketPath });
  base = `http://127.0.0.1:${relay.port}`;
  await waitFor(async () => (await fetch(`${base}/agents/activity`)).status === 200, 20_000, "relay connected to the host");
});

after(async () => {
  relay?.cleanup();
  await host?.stop();
  if (host) rmSync(host.dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${relay?.output.join("").slice(-3000) ?? ""}\n${host?.output.join("").slice(-3000) ?? ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const marker = (tool: string, args: unknown): string => `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;

interface Member {
  id: string;
  title: string | null;
  agentId: string;
  model: string | null;
  room: { role: string; parentId?: string; createdBy: string; task: string; area?: string; report?: { status: string; summary: string; artifacts: string[] }; undeliveredReports?: string[] };
}

async function members(roomId: string): Promise<Member[]> {
  return ((await (await fetch(`${base}/rooms/${roomId}`)).json()) as { members: Member[] }).members;
}

async function createRoom(body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/rooms`, { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd: host.dir, title: "Test room", ...body }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { roomId: string }).roomId;
}

/** One turn of the principal: what its tool calls answered, as the turn's
 * final text (`room: <last result>`) and every tool result. */
async function principalTurn(socket: WebSocket, text: string): Promise<{ last: string; results: { content: string; isError: boolean }[] }> {
  const done = collectUntil(socket, isTurnEnded, 30_000);
  sendUserMessage(socket, text);
  const messages = await done;
  const events = messages.filter((message) => message.type === "agent_event").map((message) => message.event as Record<string, unknown>);
  const results = events.filter((event) => event.type === "tool_ended").map((event) => ({ content: String(event.content), isError: event.isError === true }));
  const texts = events.filter((event) => event.type === "text").map((event) => (typeof event.text === "string" ? event.text : ""));
  const finalText = [...texts].reverse().find((text) => text.startsWith("room: ")) ?? "";
  return { last: finalText.slice("room: ".length), results };
}

async function hostAgents(): Promise<AgentActivity[]> {
  return ((await (await fetch(`${base}/agents/activity`)).json()) as { agents: AgentActivity[] }).agents;
}

test("the principal delegates, the worker is born in the host, works and reports back; workers stay off the session list", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const report = marker("report", { status: "done", summary: "README has 42 lines", artifacts: ["result-count.md"] });
    const { last, results } = await principalTurn(socket, `count the lines ${marker("delegate", { task: `Count the lines of README ${report}`, runtime: "claude", model: "haiku", area: "Research" })}`);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false, results[0].content);
    const { agentId } = JSON.parse(last) as { agentId: string };
    assert.match(agentId, /^[0-9a-f-]{36}$/);

    await waitFor(async () => (await members(roomId)).find((member) => member.id === agentId)?.room.report !== undefined, 20_000, "the worker's report");
    const room = await members(roomId);
    const principal = room.find((member) => member.id === roomId)!;
    const worker = room.find((member) => member.id === agentId)!;
    assert.equal(principal.room.role, "principal");
    assert.deepEqual(principal.room.undeliveredReports, [agentId], "the report waits in the principal's outbox");
    assert.equal(worker.room.role, "worker");
    assert.equal(worker.room.createdBy, "agent");
    assert.equal(worker.room.parentId, roomId);
    assert.equal(worker.room.area, "Research");
    assert.equal(worker.agentId, "claude");
    assert.equal(worker.model, "haiku");
    assert.ok(worker.title?.startsWith("Count the lines of README"), "titled from its task, no title generated");
    assert.deepEqual(worker.room.report && { status: worker.room.report.status, summary: worker.room.report.summary, artifacts: worker.room.report.artifacts }, {
      status: "done",
      summary: "README has 42 lines",
      artifacts: ["result-count.md"],
    });

    const agents = await hostAgents();
    assert.ok(agents.some((agent) => agent.agentId === roomId && agent.roomId === roomId), "the principal runs in the host");
    assert.ok(agents.some((agent) => agent.agentId === agentId && agent.roomId === roomId), "the worker runs in the host, in the same room");

    const sessions = ((await (await fetch(`${base}/sessions`)).json()) as { sessions: { id: string }[] }).sessions.map((row) => row.id);
    assert.ok(sessions.includes(roomId), "the room is listed");
    assert.ok(!sessions.includes(agentId), "its worker is not");

    // message_agent: only to a descendant; delivered as the worker's next turn.
    const messaged = await principalTurn(socket, `ping ${marker("message_agent", { agentId, text: "please also count CHANGELOG" })} ${marker("message_agent", { agentId: "not-in-room", text: "hi" })}`);
    assert.equal(messaged.results[0].isError, false, messaged.results[0].content);
    assert.equal(messaged.results[1].isError, true);
    assert.match(messaged.results[1].content, /no agent "not-in-room" below you/);

    const status = await principalTurn(socket, `status ${marker("room_status", {})}`);
    const listed = JSON.parse(status.last) as { agents: { agentId: string; state: string; report?: { summary: string } }[] };
    assert.deepEqual(listed.agents.map((agent) => agent.agentId), [agentId]);
    assert.equal(listed.agents[0].report?.summary, "README has 42 lines");
  } finally {
    socket.close();
  }
});

test("delegate refuses an unknown runtime, a parent outside the room, and a worker cannot delegate or a principal report", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const { results } = await principalTurn(
      socket,
      [
        marker("delegate", { task: "x", runtime: "gemini", model: "pro" }),
        marker("delegate", { task: "x", runtime: "claude", model: "haiku", parentId: "someone-else" }),
        marker("delegate", { task: "x", runtime: "claude" }),
        marker("report", { status: "done", summary: "not mine to send" }),
      ].join(" "),
    );
    assert.equal(results.length, 4);
    assert.ok(results.every((result) => result.isError), JSON.stringify(results));
    assert.match(results[0].content, /Unknown runtime "gemini"\. Use one of: claude/);
    assert.match(results[1].content, /no agent "someone-else" in this room/);
    assert.match(results[2].content, /model is required/);
    assert.match(results[3].content, /Unknown tool "report" for this agent/, "the principal is never offered report");
    assert.equal((await members(roomId)).length, 1, "nothing was created");

    // A worker that tries to delegate is refused the same way.
    const { last } = await principalTurn(socket, marker("delegate", { task: `try ${marker("delegate", { task: "nested", runtime: "claude", model: "haiku" })}`, runtime: "claude", model: "haiku" }));
    const { agentId } = JSON.parse(last) as { agentId: string };
    await waitFor(async () => {
      const agent = (await hostAgents()).find((candidate) => candidate.agentId === agentId);
      return agent !== undefined && agent.state === "idle";
    }, 20_000, "the worker's turn");
    assert.equal((await members(roomId)).length, 2, "the worker's delegate created nothing");
  } finally {
    socket.close();
  }
});

test("a room has at most 10 live agents: the next delegate fails with the limit, nothing is started", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const calls = Array.from({ length: 10 }, (_, index) => marker("delegate", { task: `idle helper ${index}`, runtime: "claude", model: "haiku" }));
    const { results } = await principalTurn(socket, calls.join(" "));
    assert.equal(results.length, 10);
    assert.deepEqual(results.slice(0, 9).map((result) => result.isError), Array(9).fill(false), JSON.stringify(results.slice(0, 9)));
    assert.equal(results[9].isError, true);
    assert.match(results[9].content, /already has 10 live agents, the limit is 10/);
    assert.equal((await members(roomId)).length, 10, "principal + 9 workers");
  } finally {
    socket.close();
  }
});
