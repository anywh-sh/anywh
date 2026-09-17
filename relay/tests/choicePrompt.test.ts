import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";
import type { ChoiceQuestion } from "../src/bridges/mcpBridge.js";

// Real integration test (.anywh/skills/tests/SKILL.md): exercises the
// present_choice/permission-bridge flow end to end over the real WebSocket
// protocol (choice_prompt -> choice_answer -> choice_resolved). The real
// mechanism (relay/src/mcpBridge.ts) needs a `claude` child that speaks
// MCP's "Streamable HTTP" transport mid-turn, which the fake claude fixture
// doesn't (and shouldn't) implement — but `plan` mode's text-marker fallback
// (relay/src/planChoiceMarker.ts) reaches the EXACT SAME
// SharedSession.presentChoice/answerChoice state machine and IS reachable
// through the fixture, since it only depends on the turn's final assistant
// text (something the fake claude already controls via FAKE_CLAUDE_REPLY).
// This is genuinely the same protocol/state machine `ChoiceCard`
// (client/src/components/chat/ChoiceCard.tsx) drives for either kind of
// prompt — see SharedSession's `pendingChoice` doc comment for how the two
// "kind"s share everything except who currently owns resolving them.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_REPLY;
});

test("a plan-mode marker becomes a choice_prompt, and answering it enqueues the answer as a real follow-up turn", async () => {
  const socket = await connectSession(server.port, "session-choice");
  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "plan" }));

  process.env.FAKE_CLAUDE_REPLY =
    "Here's the plan.\n\n" +
    ">>>QUESTION: Which approach?\n" +
    "- Rewrite from scratch\n" +
    "- Patch the existing code\n" +
    ">>>END";
  sendUserMessage(socket, "how should we do this");

  // One single wait for `choice_prompt`, not two sequential `collectUntil`
  // calls for `turn_complete` then `choice_prompt`: both messages are sent
  // back to back with no `await` in between (SharedSession.runTurn), so a
  // separate wait for `turn_complete` first risks the `choice_prompt` frame
  // arriving (and being silently dropped, no listener registered yet)
  // before the second `collectUntil` call attaches.
  const firstTurnMessages = await collectUntil(socket, (message) => message.type === "choice_prompt");

  const turnEnded = firstTurnMessages.find(isTurnEnded);
  assert.deepEqual(turnEnded, { type: "agent_event", event: { type: "turn_ended", stopped: false } });

  const choicePrompt = firstTurnMessages.at(-1) as { type: string; promptId: string; questions: ChoiceQuestion[]; kind: string };
  assert.equal(choicePrompt.type, "choice_prompt");
  // A plan-mode marker has no live `claude` call blocked waiting for the
  // answer (SharedSession.pendingChoice) — `kind: "choice"` is what tells
  // `ChoiceCard`'s close button it's safe to dismiss with no answer sent.
  assert.equal(choicePrompt.kind, "choice");
  assert.equal(choicePrompt.questions.length, 1);
  assert.equal(choicePrompt.questions[0].question, "Which approach?");
  assert.deepEqual(
    choicePrompt.questions[0].options.map((option) => option.label),
    ["Rewrite from scratch", "Patch the existing code"],
  );
  assert.ok(choicePrompt.promptId);

  // Answering enqueues the selection as an ordinary new turn (no live
  // `claude` call is blocked waiting for this one, unlike the MCP path —
  // SharedSession.answerChoice's "planText" branch).
  process.env.FAKE_CLAUDE_REPLY = "Great, rewriting from scratch then.";
  socket.send(
    JSON.stringify({
      type: "choice_answer",
      promptId: choicePrompt.promptId,
      answers: [{ question: "Which approach?", selected: ["Rewrite from scratch"] }],
    }),
  );

  const secondTurnMessages = await collectUntil(socket, isTurnEnded);

  const resolved = secondTurnMessages.find((message) => message.type === "choice_resolved") as
    | { type: string; promptId: string }
    | undefined;
  assert.deepEqual(resolved, { type: "choice_resolved", promptId: choicePrompt.promptId });

  // formatPlanChoiceAnswerText's single-answer shape (planChoiceMarker.ts):
  // just the selected label, not "question: label".
  const syntheticPrompt = secondTurnMessages.find(
    (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "user_message",
  );
  assert.equal((syntheticPrompt!.event as { text?: string }).text, "Rewrite from scratch");

  const secondTurnEnded = secondTurnMessages.at(-1);
  assert.deepEqual(secondTurnEnded, { type: "agent_event", event: { type: "turn_ended", stopped: false } });

  socket.close();
});
