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
import { collectUntil, connectSession, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

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
    const listed = JSON.parse(status.last) as { agents: { agentId: string; state: string; report?: { summary: string; fromRelay?: boolean } }[] };
    assert.deepEqual(listed.agents.map((agent) => agent.agentId), [agentId]);
    // The message's turn ended without a report: the relay says so.
    assert.deepEqual(listed.agents[0].report && { summary: listed.agents[0].report.summary, fromRelay: listed.agents[0].report.fromRelay }, {
      summary: "The agent ended its turn without reporting.",
      fromRelay: true,
    });
    assert.equal(listed.agents[0].state, "blocked");
  } finally {
    socket.close();
  }
});

test("delegate refuses an unknown runtime or model, a parent outside the room, and a worker cannot delegate or a principal report", async () => {
  // The model catalog the relay probed off the (fake) CLI at boot.
  await waitFor(async () => {
    try {
      const { socket: probe } = await connectSessionAndCollectUntil(
        relay.port,
        "catalog-probe",
        (message) => message.type === "model_catalogs_state" && JSON.stringify(message).includes("fake-sonnet"),
        2000,
      );
      probe.close();
      return true;
    } catch {
      return false;
    }
  }, 20_000, "the model catalog");
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
        marker("delegate", { task: "x", runtime: "claude", model: "gpt-9" }),
        marker("delegate", { task: "x", runtime: "claude", model: "fake-sonnet", effort: "ultra" }),
      ].join(" "),
    );
    assert.equal(results.length, 6);
    assert.match(results[4].content, /Model "gpt-9" is not one claude offers here\. Use one of: fake-sonnet, fake-opus/);
    assert.match(results[5].content, /takes effort low, medium, high, max/);
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
    assert.match(results[9].content, /^room_cap_reached: this room already has 10 agents at work, the limit is 10/);
    assert.equal((await members(roomId)).length, 10, "principal + 9 workers");
  } finally {
    socket.close();
  }
});

test("the principal runs read-only with no native subagents; workers run with native subagents capped", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const { last } = await principalTurn(socket, marker("delegate", { task: "plain worker", runtime: "claude", model: "haiku" }));
    const { agentId } = JSON.parse(last) as { agentId: string };
    const envOf = (id: string): Record<string, string> | undefined =>
      readFileSync(join(host.dir, "env.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, string>)
        .find((env) => env.ANYWH_AGENT_MARK?.split(":")[1] === id);
    await waitFor(() => envOf(agentId) !== undefined, 15_000, "the worker's process");

    const spawns = readFileSync(argvFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const principalArgs = spawns.find((args) => flag(args, "--append-system-prompt")?.startsWith("You are the principal agent of an anywh room"));
    assert.ok(principalArgs, "a principal was spawned");
    assert.equal(flag(principalArgs, "--tools"), "Read,Grep,Glob");
    assert.ok(flag(principalArgs, "--disallowedTools")!.split(",").includes("Agent"));
    assert.ok(principalArgs.includes("--strict-mcp-config"));
    assert.ok(flag(principalArgs, "--allowedTools")!.includes("mcp__anywh-room__delegate"));
    const principalEnv = envOf(roomId)!;
    assert.equal(principalEnv.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, undefined);

    const workerArgs = spawns.find((args) => flag(args, "--append-system-prompt")?.startsWith("You are an agent of an anywh room"));
    assert.ok(workerArgs, "a worker was spawned");
    assert.equal(flag(workerArgs, "--tools"), undefined, "a worker has every tool");
    assert.equal(flag(workerArgs, "--allowedTools"), "mcp__anywh-room__report");
    assert.equal(flag(workerArgs, "--model"), "haiku");
    const workerEnv = envOf(agentId)!;
    assert.equal(workerEnv.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "5");
    assert.equal(workerEnv.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "1");
  } finally {
    socket.close();
  }
});

test("a worker's native subagents are its subtasks: listed, and stopped one by one through the host", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const { last } = await principalTurn(socket, marker("delegate", { task: "survey in parallel [[subagent]]", runtime: "claude", model: "haiku" }));
    const { agentId } = JSON.parse(last) as { agentId: string };
    const url = `${base}/rooms/${roomId}/agents/${agentId}/subtasks`;
    type Subtask = { taskId: string; toolUseId: string; description?: string; status: string; background: boolean };
    let subtasks: Subtask[] = [];
    await waitFor(async () => {
      const res = await fetch(url);
      if (res.status !== 200) return false;
      subtasks = ((await res.json()) as { subtasks: Subtask[] }).subtasks;
      return subtasks.length === 1;
    }, 20_000, "the subtask listed");
    assert.equal(subtasks[0].status, "running");
    assert.equal(subtasks[0].description, "survey the repo");
    assert.equal(subtasks[0].background, true);
    const agent = (await hostAgents()).find((candidate) => candidate.agentId === agentId)!;
    assert.equal(agent.backgroundTasks, 1, "the host counts it as background work");

    const stop = await fetch(`${url}/${subtasks[0].taskId}/stop`, { method: "POST" });
    assert.equal(stop.status, 200, await stop.clone().text());
    await waitFor(async () => {
      subtasks = ((await (await fetch(url)).json()) as { subtasks: Subtask[] }).subtasks;
      return subtasks[0]?.status === "stopped";
    }, 15_000, "the subtask stopped");
    await waitFor(async () => (await hostAgents()).find((candidate) => candidate.agentId === agentId)?.backgroundTasks === 0, 15_000, "no background work left");
    assert.equal((await hostAgents()).find((candidate) => candidate.agentId === agentId)?.alive, true, "stopping a subtask keeps the worker");

    assert.equal((await fetch(`${url}/nope/stop`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/not-a-member/subtasks`)).status, 404);
  } finally {
    socket.close();
  }
});

test("nobody types into a worker: its turns leave no next-message suggestion, while the principal's do", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  const suggestionOf = async (id: string): Promise<unknown> => {
    const { socket: probe, messages } = await connectSessionAndCollectUntil(relay.port, id, (message) => message.type === "caught_up", 10_000);
    probe.close();
    return messages.find((message) => message.type === "suggestion")?.text;
  };
  try {
    const { last } = await principalTurn(socket, marker("delegate", { task: "just answer", runtime: "claude", model: "haiku" }));
    const workerId = (JSON.parse(last) as { agentId: string }).agentId;
    await waitFor(async () => (await hostAgents()).find((agent) => agent.agentId === workerId)?.state === "idle", 15_000, "the worker's turn");
    // A principal turn after the worker's: its suggestion is generated after
    // the worker's would have been, through the same path.
    await principalTurn(socket, "anything new?");
    await waitFor(async () => typeof (await suggestionOf(roomId)) === "string", 15_000, "the principal's suggestion");
    assert.equal(await suggestionOf(workerId), null);
  } finally {
    socket.close();
  }
});

test("a malformed room URL is refused, never taking the relay down", async () => {
  for (const path of ["/room/%ZZ/token", "/rooms/%ZZ", "/rooms/%ZZ/canvas", "/rooms/x/agents/%ZZ/subtasks"]) {
    const res = await fetch(`${base}${path}`, { method: path.startsWith("/room/") ? "POST" : "GET", body: path.startsWith("/room/") ? "{}" : undefined });
    assert.ok(res.status === 400 || res.status === 404, `${path}: ${res.status}`);
  }
  assert.equal((await fetch(`${base}/sessions`)).status, 200, "still up");
});

test("stopping a worker frees its place, drops what was queued for it and never brings it back; deleting the principal removes the room", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    // Nine workers busy in a turn that only ends when interrupted.
    const calls = Array.from({ length: 9 }, (_, index) => marker("delegate", { task: `busy ${index} [[hang]]`, runtime: "claude", model: "haiku" }));
    const { results } = await principalTurn(socket, calls.join(" "));
    const ids = results.map((result) => (JSON.parse(result.content) as { agentId: string }).agentId);
    await waitFor(async () => (await hostAgents()).filter((agent) => ids.includes(agent.agentId) && agent.state === "working").length === 9, 20_000, "nine workers at work");
    const full = await principalTurn(socket, marker("delegate", { task: "one more", runtime: "claude", model: "haiku" }));
    assert.match(full.results[0].content, /^room_cap_reached/);

    // A message queued behind the busy turn of the first one, then it is stopped.
    const queued = await principalTurn(socket, marker("message_agent", { agentId: ids[0], text: "after that, do more" }));
    assert.equal(queued.results[0].isError, false, queued.results[0].content);
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/${ids[0]}/stop`, { method: "POST" })).status, 200);
    const stopped = (await members(roomId)).find((member) => member.id === ids[0]) as Member & { room: { stopped?: { reason: string }; queuedMessages?: unknown[] } };
    assert.equal(stopped.room.stopped?.reason, "user");
    assert.equal(stopped.room.queuedMessages, undefined, "what was queued for it is dropped");
    await waitFor(async () => (await hostAgents()).find((agent) => agent.agentId === ids[0])?.state === "stopped", 15_000, "stopped in the host");

    // Typed into directly, it refuses instead of coming back.
    const direct = await connectSession(relay.port, ids[0]);
    const refused = collectUntil(direct, (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "error", 15_000);
    sendUserMessage(direct, "are you there?");
    const errors = await refused;
    direct.close();
    assert.match(String((errors.at(-1)!.event as { message: string }).message), /was stopped/);
    assert.equal((await hostAgents()).find((agent) => agent.agentId === ids[0])?.state, "stopped", "still stopped in the host");

    const again = await principalTurn(socket, marker("delegate", { task: "now it fits", runtime: "claude", model: "haiku" }));
    assert.equal(again.results[0].isError, false, again.results[0].content);
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/${roomId}/stop`, { method: "POST" })).status, 400, "the principal is not stopped this way");
    assert.equal((await fetch(`${base}/rooms/${roomId}/agents/${ids[0]}/resume`, { method: "POST" })).status, 200);
    assert.equal(((await members(roomId)).find((member) => member.id === ids[0]) as Member & { room: { stopped?: unknown } }).room.stopped, undefined);
  } finally {
    socket.close();
  }
  const before = (await members(roomId)).map((member) => member.id);
  const deleted = await fetch(`${base}/sessions/delete`, { method: "POST", body: JSON.stringify({ id: roomId }) });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${base}/rooms/${roomId}`)).status, 404);
  await waitFor(async () => {
    const agents = await hostAgents();
    return before.every((id) => !agents.some((agent) => agent.agentId === id));
  }, 20_000, "every agent of the room removed from the host");
});

test("a worker whose turn fails, or ends without a report, gets one from the relay, and the principal's outbox has it", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const { results } = await principalTurn(socket, [marker("delegate", { task: "boom [[crash]]", runtime: "claude", model: "haiku" }), marker("delegate", { task: "just chat", runtime: "claude", model: "haiku" })].join(" "));
    const [crashed, silent] = results.map((result) => (JSON.parse(result.content) as { agentId: string }).agentId);
    await waitFor(async () => {
      const room = await members(roomId);
      return room.find((member) => member.id === crashed)?.room.report !== undefined && room.find((member) => member.id === silent)?.room.report !== undefined;
    }, 20_000, "both reports");
    const room = await members(roomId);
    const failed = room.find((member) => member.id === crashed)!.room.report as { status: string; summary: string; synthetic?: boolean };
    assert.equal(failed.status, "failed");
    assert.equal(failed.synthetic, true);
    assert.match(failed.summary, /^The agent's turn failed: the agent's process exited/);
    const blocked = room.find((member) => member.id === silent)!.room.report as { status: string; summary: string; synthetic?: boolean };
    assert.deepEqual([blocked.status, blocked.summary, blocked.synthetic], ["blocked", "The agent ended its turn without reporting.", true]);
    assert.deepEqual(new Set(room.find((member) => member.id === roomId)!.room.undeliveredReports), new Set([crashed, silent]));

    const status = await principalTurn(socket, marker("room_status", {}));
    const states = Object.fromEntries((JSON.parse(status.last) as { agents: { agentId: string; state: string }[] }).agents.map((agent) => [agent.agentId, agent.state]));
    assert.deepEqual(states, { [crashed]: "failed", [silent]: "blocked" });
  } finally {
    socket.close();
  }
});

test("messages wait in a bounded, persisted queue; removing a worker removes the agents below it and its report", async () => {
  const roomId = await createRoom();
  const socket = await connectSession(relay.port, roomId);
  try {
    const first = await principalTurn(socket, marker("delegate", { task: "long job [[hang]]", runtime: "claude", model: "haiku" }));
    const busy = (JSON.parse(first.last) as { agentId: string }).agentId;
    await waitFor(async () => (await hostAgents()).find((agent) => agent.agentId === busy)?.state === "working", 15_000, "busy");
    const sends = Array.from({ length: 6 }, (_, index) => marker("message_agent", { agentId: busy, text: `note ${index}` }));
    const { results } = await principalTurn(socket, sends.join(" "));
    assert.deepEqual(results.map((result) => result.isError), [false, false, false, false, false, true]);
    assert.match(results[5].content, /already has 5 messages waiting/);
    const queued = (await members(roomId)).find((member) => member.id === busy)! as Member & { room: { queuedMessages?: { text: string }[] } };
    assert.deepEqual(queued.room.queuedMessages?.map((message) => message.text), ["note 0", "note 1", "note 2", "note 3", "note 4"], "persisted in the room record");

    // A child under the busy worker, then the busy worker is removed.
    const child = await principalTurn(socket, marker("delegate", { task: `child [[room:report:${Buffer.from(JSON.stringify({ status: "done", summary: "child done" })).toString("base64url")}]]`, runtime: "claude", model: "haiku", parentId: busy }));
    const childId = (JSON.parse(child.last) as { agentId: string }).agentId;
    await waitFor(async () => (await members(roomId)).find((member) => member.id === childId)?.room.report !== undefined, 15_000, "child report");
    assert.equal((await fetch(`${base}/sessions/delete`, { method: "POST", body: JSON.stringify({ id: busy }) })).status, 200);
    const left = await members(roomId);
    assert.deepEqual(left.map((member) => member.id), [roomId], "the subtree is gone");
    assert.deepEqual(left[0].room.undeliveredReports ?? [], [], "and its reports with it");
  } finally {
    socket.close();
  }
});
