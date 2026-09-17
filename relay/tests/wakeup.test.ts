import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, findAgentEvent, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): exercises
// `WakeupScheduler` end to end over the real WebSocket protocol and the real
// relay process — only the model's decision to call `ScheduleWakeup` is
// faked (fixtures/fake-claude.mjs's `FAKE_CLAUDE_SCHEDULE_WAKEUP`), the
// `tool_started`/`tool_ended` pair it produces goes through the real
// `mapClaudeEvent`/`SessionManager.onEvent`/`WakeupScheduler.observeEvent`
// pipeline, and the wakeup firing spawns a REAL second `claude` invocation
// (`--resume <sessionId>`), proving the fix's actual claim: a
// `ScheduleWakeup` call outlives the turn's own `claude -p` process, which
// exits at the end of every turn (spawn-per-turn) and would otherwise leave
// nothing to run the harness's own internal timer on.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
  delete process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
  delete process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP;
});

test("a successful ScheduleWakeup call fires on its own, resuming the same session with the model's own prompt", async () => {
  const socket = await connectSession(server.port, "session-wakeup");

  process.env.FAKE_CLAUDE_REPLY = "sure, I'll check back in a bit";
  process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP = JSON.stringify({
    delaySeconds: 0.05,
    prompt: "keep going on the loop task",
  });
  sendUserMessage(socket, "please schedule a wakeup for the loop");

  const firstTurnMessages = await collectUntil(socket, isTurnEnded);
  const firstSessionId = (findAgentEvent(firstTurnMessages, "session_id")!.event as { sessionId?: string }).sessionId;
  assert.ok(firstSessionId, "the turn that called ScheduleWakeup should still produce a session_id");

  // The turn that called ScheduleWakeup has already ended (its `claude -p`
  // process has exited) — nothing further is sent on the socket. The next
  // turn has to come from the relay's own `WakeupScheduler` timer firing on
  // its own, unprompted by any client message.
  delete process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP;
  process.env.FAKE_CLAUDE_REPLY = "back on it";

  const wakeupTurnMessages = await collectUntil(socket, isTurnEnded, 5000);

  const secondSessionId = (findAgentEvent(wakeupTurnMessages, "session_id")!.event as { sessionId?: string }).sessionId;
  // Same reasoning as sessionLifecycle.test.ts's resume assertion: the fake
  // `claude` echoes `--resume <id>` back as the session_id, so a stable id
  // across the two turns proves the relay actually resumed this session's
  // conversation for the wakeup turn, not started a fresh one.
  assert.equal(secondSessionId, firstSessionId);

  const syntheticPrompt = findAgentEvent(wakeupTurnMessages, "user_message") as
    | { event: { text?: string; synthetic?: string; label?: string } }
    | undefined;
  assert.ok(syntheticPrompt, "the wakeup turn should broadcast a synthetic user_message");
  // Verbatim, not wrapped into a synthesized instruction the way
  // buildBackgroundJobFollowupPrompt does for anywh-bg — this IS what the
  // model itself wrote as `prompt`.
  assert.equal(syntheticPrompt.event.text, "keep going on the loop task");
  assert.equal(syntheticPrompt.event.synthetic, "wakeup");

  const turnEnded = wakeupTurnMessages.at(-1);
  assert.deepEqual(turnEnded, { type: "agent_event", event: { type: "turn_ended", stopped: false } });

  socket.close();
});
