import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test for the session's activity clock (ActivityClock):
// Claude's stream reports no timing on tool calls, so every timestamp the
// client gets for one has to be stamped by the relay on the way through —
// proven here against the real WebSocket stack, not just the pure unit.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_PARALLEL_TOOLS;
});

type Event = { type: string; [key: string]: unknown };

test("a live turn carries its start, its duration, and a start and end on every tool call", async () => {
  const socket = await connectSession(server.port, "session-activity-timing");

  process.env.FAKE_CLAUDE_PARALLEL_TOOLS = "1";
  const before = Date.now();
  sendUserMessage(socket, "run two commands in parallel");
  const messages = await collectUntil(socket, isTurnEnded);
  const after = Date.now();

  const events = messages.filter((m) => m.type === "agent_event").map((m) => m.event as Event);
  const started = events.find((e) => e.type === "turn_started");
  const ended = events.find((e) => e.type === "turn_ended");
  assert.ok(started && typeof started.startedAt === "number", `turn_started without startedAt: ${JSON.stringify(started)}`);
  assert.ok((started.startedAt) >= before && (started.startedAt) <= after);
  assert.ok(ended && typeof ended.durationMs === "number", `turn_ended without durationMs: ${JSON.stringify(ended)}`);
  assert.ok((ended.durationMs) <= after - before);

  const toolStarts = events.filter((e) => e.type === "tool_started");
  const toolEnds = events.filter((e) => e.type === "tool_ended");
  assert.equal(toolStarts.length, 2);
  assert.equal(toolEnds.length, 2);
  for (const start of toolStarts) {
    const end = toolEnds.find((e) => e.toolUseId === start.toolUseId);
    assert.ok(typeof start.startedAt === "number" && typeof end?.endedAt === "number", `unstamped call ${String(start.toolUseId)}`);
    assert.ok((end.endedAt) >= (start.startedAt), "a call can't end before it starts");
    assert.ok((start.startedAt) >= (started.startedAt), "a call can't start before its turn");
  }

  socket.close();
});
