import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the
// context_attribution fan-out (SharedSession.emitContextAttribution) —
// against the real WebSocket/HTTP stack, a real parallel tool-call batch
// (two tool_use blocks in one assistant message), not just
// contextAttribution.test.ts's pure unit table.

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

test("a parallel tool-call batch fans out into one context_attribution event per tool, divided proportionally", async () => {
  const socket = await connectSession(server.port, "session-context-attribution-live");

  // First turn: ordinary — establishes the model, same prerequisite as
  // contextUsageLive.test.ts's live-chip test.
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);

  process.env.FAKE_CLAUDE_PARALLEL_TOOLS = "1";
  sendUserMessage(socket, "run two commands in parallel");
  const messages = await collectUntil(socket, isTurnEnded);

  const attributionEvents = messages
    .filter((m) => m.type === "agent_event" && (m.event as { type?: string }).type === "context_attribution")
    .map((m) => m.event as { type: string; toolUseIds: string[]; tokens: number; estimated: boolean });

  assert.equal(attributionEvents.length, 2, `expected 2 context_attribution events, got ${JSON.stringify(attributionEvents)}`);
  // delta 50 (60 - 10), divided by content length 1 vs 10 (total weight 11):
  // round(50*1/11)=5, the other tool absorbs the remainder: 50-5=45.
  assert.deepEqual(attributionEvents, [
    { type: "context_attribution", toolUseIds: ["toolu_parallel_a"], tokens: 5, estimated: true },
    { type: "context_attribution", toolUseIds: ["toolu_parallel_b"], tokens: 45, estimated: true },
  ]);

  const turnEndedIndex = messages.findIndex(isTurnEnded);
  const lastAttributionIndex = messages.lastIndexOf(
    messages.filter((m) => m.type === "agent_event" && (m.event as { type?: string }).type === "context_attribution").at(-1)!,
  );
  assert.ok(lastAttributionIndex < turnEndedIndex, "context_attribution must arrive before turn_ended, not after");

  socket.close();
});
