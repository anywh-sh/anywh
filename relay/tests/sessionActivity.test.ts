import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, connectSessionListWatch, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the `activity` a
// session's row carries on the session list: a device that never opened the
// session (no tab, no session socket) still learns that a turn runs in it
// or that it waits for the person, from `/sessions/watch` and `GET /sessions`
// alone. Only the model is faked (FAKE_CLAUDE_HANG, FAKE_CLAUDE_REQUEST_TOOLS).

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
});

type Upsert = { type: string; id?: string; activity?: string };

function upsertOf(id: string, matches: (activity: string | undefined) => boolean) {
  return (message: Record<string, unknown>): boolean => {
    const upsert = message as Upsert;
    return upsert.type === "session_list_upsert" && upsert.id === id && matches(upsert.activity);
  };
}

async function listedActivity(id: string): Promise<string | undefined> {
  const body = (await (await fetch(`http://127.0.0.1:${server.port}/sessions`)).json()) as { sessions: { id: string; activity?: string }[] };
  return body.sessions.find((session) => session.id === id)?.activity;
}

/** A first turn, so the session is titled and listed. */
async function titledSession(id: string): Promise<void> {
  const watcher = await connectSessionListWatch(server.port);
  const titled = collectUntil(watcher, upsertOf(id, () => true));
  const socket = await connectSession(server.port, id);
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);
  socket.close();
  await titled;
  watcher.close();
}

test("a running turn reaches the list as activity running, and its end as no activity", async () => {
  await titledSession("activity-running");
  const watcher = await connectSessionListWatch(server.port);
  const running = collectUntil(watcher, upsertOf("activity-running", (activity) => activity === "running"));

  process.env.FAKE_CLAUDE_HANG = "1";
  const socket = await connectSession(server.port, "activity-running");
  sendUserMessage(socket, "please hang");
  await collectUntil(socket, (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "session_id");
  // The tab goes away; the turn goes on.
  socket.close();
  await running;
  assert.equal(await listedActivity("activity-running"), "running");

  const idle = collectUntil(watcher, upsertOf("activity-running", (activity) => activity === undefined));
  const stopper = await connectSession(server.port, "activity-running");
  stopper.send(JSON.stringify({ type: "stop_turn" }));
  await idle;
  assert.equal(await listedActivity("activity-running"), undefined);
  stopper.close();
  watcher.close();
});

test("an approval the turn is blocked on reaches the list as activity awaiting, and answering it moves on", async () => {
  await titledSession("activity-awaiting");
  const watcher = await connectSessionListWatch(server.port);
  const upserts = collectUntil(watcher, upsertOf("activity-awaiting", (activity) => activity === "awaiting"));

  process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify([{ tool: "Bash", input: { command: "echo hi" } }]);
  const socket = await connectSession(server.port, "activity-awaiting");
  // The default mode never asks.
  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "default" }));
  const prompted = collectUntil(socket, (message) => message.type === "choice_prompt");
  sendUserMessage(socket, "run something");
  const prompt = (await prompted).at(-1) as { promptId: string; questions: { question: string }[] };
  await upserts;
  assert.equal(await listedActivity("activity-awaiting"), "awaiting");

  const settled = collectUntil(watcher, upsertOf("activity-awaiting", (activity) => activity === undefined));
  const ended = collectUntil(socket, isTurnEnded);
  socket.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: [{ question: prompt.questions[0].question, selected: ["deny"] }] }));
  const after = await settled;
  // Released, the turn runs again before it ends.
  const activities = after.filter(upsertOf("activity-awaiting", () => true)).map((message) => (message as Upsert).activity);
  assert.deepEqual(activities, ["running", undefined]);
  await ended;
  socket.close();
  watcher.close();
});
