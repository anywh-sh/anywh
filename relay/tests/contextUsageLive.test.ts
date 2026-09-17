import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the context chip's
// live update (SharedSession.runTurn's ContextAttributor wiring) — proves it
// broadcasts more than once mid-turn, not just once from the end-of-turn
// `result` event, against the real WebSocket/HTTP stack.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_TWO_USAGE_EVENTS;
});

test("the context chip updates twice mid-turn, both before turn_ended, once a model is already known from an earlier turn", async () => {
  const socket = await connectSession(server.port, "session-context-live");

  // First turn: ordinary — this is what teaches SharedSession the model, so
  // the second turn's mid-turn updates have something to attach a
  // ContextUsage.model to (see sharedSession.ts's own comment on why a
  // session's very first turn can't show a live chip before this).
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);

  process.env.FAKE_CLAUDE_TWO_USAGE_EVENTS = "1";
  sendUserMessage(socket, "think then reply");
  const messages = await collectUntil(socket, isTurnEnded);

  let lastUsageIndex = -1;
  let turnEndedIndex = -1;
  const usedTokensSeen: number[] = [];
  messages.forEach((message, index) => {
    if (message.type === "context_usage_state") {
      lastUsageIndex = index;
      usedTokensSeen.push((message.usage as { usedTokens: number }).usedTokens);
    }
    if (isTurnEnded(message)) turnEndedIndex = index;
  });

  assert.ok(usedTokensSeen.length >= 2, `expected at least 2 context_usage_state frames, got ${usedTokensSeen.length}: ${JSON.stringify(usedTokensSeen)}`);
  // The fixture's two assistant events carry prefixTokens 10 and 50 — the
  // live update must reflect each one as it arrives, not just the final.
  assert.deepEqual(usedTokensSeen.slice(0, 2), [10, 50]);
  assert.ok(lastUsageIndex < turnEndedIndex, "a context_usage_state frame must arrive before turn_ended, not only after");

  socket.close();
});
