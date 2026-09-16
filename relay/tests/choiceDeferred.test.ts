import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, connectSessionAndCollectUntil, sendUserMessage } from "./helpers/wsClient.js";
import { CHOICE_DEFERRED_RESPONSE_TEXT } from "../src/bridges/mcpBridge.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the
// deferred-lifecycle rework: `present_choice` used to hold the MCP
// `tools/call` open until a human answered (SharedSession.presentChoice used
// to return a Promise), which the real CLI kills after ~6 minutes with no
// working override. It now replies immediately and
// the human's eventual answer arrives as a brand new turn instead.
//
// Unlike `choicePrompt.test.ts` (which only reaches the plan-mode text-marker
// path, since the fake `claude` fixture doesn't speak MCP), this one drives
// the REAL `McpChoiceBridge`/HTTP transport too: `fake-claude.mjs`'s
// `FAKE_CLAUDE_PRESENT_CHOICE` env var makes it perform the actual MCP
// "Streamable HTTP" handshake against the bridge URL the relay hands it via
// `--mcp-config`, exactly like the real `claude` binary would. Only the
// model's decision to call the tool is faked — the bridge, `SharedSession`,
// and the WebSocket broadcast are all real.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
});

test("present_choice replies immediately (not blocked on a human), the turn completes right away, and the prompt survives past turn_complete", async () => {
  const socket = await connectSession(server.port, "session-choice-deferred");

  process.env.FAKE_CLAUDE_PRESENT_CHOICE = JSON.stringify([
    { question: "Which approach?", options: [{ label: "Rewrite from scratch" }, { label: "Patch the existing code" }] },
  ]);
  sendUserMessage(socket, "how should we do this");

  // A single wait for `turn_complete`, not two sequential collects — the
  // whole behavioral claim here is that `turn_complete` arrives WITHOUT
  // anyone ever answering the `choice_prompt`. If the old blocking
  // implementation were still in place, this would hang until the 5s
  // `collectUntil` timeout instead of completing.
  const turnMessages = await collectUntil(socket, (message) => message.type === "turn_complete");

  const turnComplete = turnMessages.find((message) => message.type === "turn_complete");
  assert.deepEqual(turnComplete, { type: "turn_complete", stopped: false });

  const choicePrompt = turnMessages.find((message) => message.type === "choice_prompt") as
    | { type: string; promptId: string; questions: { question: string; options: { label: string }[] }[]; kind: string }
    | undefined;
  assert.ok(choicePrompt, "choice_prompt must have been broadcast even though nobody answered it");
  assert.equal(choicePrompt.questions[0].question, "Which approach?");
  // The MCP `present_choice` path shares `kind: "choice"` with the
  // plan-mode marker path (choicePrompt.test.ts) — neither has a live
  // `claude` call left blocked waiting for the answer.
  assert.equal(choicePrompt.kind, "choice");

  // The fake claude's "assistant reply" is literally the tool call's
  // response text — proves the relay replied to the MCP call with the
  // end-turn instruction, not with an answer (there isn't one yet).
  const resultEvent = turnMessages.find(
    (message) => message.type === "claude_event" && (message.event as { type?: string }).type === "result",
  ) as { event: { result?: string } } | undefined;
  assert.equal(resultEvent?.event.result, CHOICE_DEFERRED_RESPONSE_TEXT);

  socket.close();

  // The turn (and its underlying `claude` child) is long gone at this point
  // — `pendingChoice` must still be alive regardless (the entire point of
  // the deferred lifecycle inversion, sharedSession.ts's `runTurn` `finally`
  // no longer cancels it). A fresh device connecting now must still see the
  // prompt resent as part of the normal connection-time state burst
  // (`SharedSession.addClient`), the same way it already did for the
  // plan-mode marker path pre-rework.
  const { socket: reconnected, messages: burst } = await connectSessionAndCollectUntil(
    server.port,
    "session-choice-deferred",
    (message) => message.type === "caught_up",
  );
  const resentPrompt = burst.find((message) => message.type === "choice_prompt") as
    | { promptId: string; questions: { question: string }[] }
    | undefined;
  assert.ok(resentPrompt, "a reconnecting client must still receive the still-pending choice_prompt");
  assert.equal(resentPrompt.promptId, choicePrompt.promptId);

  reconnected.close();
});

test("answering a deferred present_choice prompt enqueues the answer as a real follow-up turn", async () => {
  const socket = await connectSession(server.port, "session-choice-deferred-answer");

  process.env.FAKE_CLAUDE_PRESENT_CHOICE = JSON.stringify([
    { question: "Which approach?", options: [{ label: "Rewrite from scratch" }, { label: "Patch the existing code" }] },
  ]);
  sendUserMessage(socket, "how should we do this");

  const firstTurnMessages = await collectUntil(socket, (message) => message.type === "turn_complete");
  const choicePrompt = firstTurnMessages.find((message) => message.type === "choice_prompt") as
    | { type: string; promptId: string }
    | undefined;
  assert.ok(choicePrompt);

  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
  process.env.FAKE_CLAUDE_REPLY = "Great, rewriting from scratch then.";
  socket.send(
    JSON.stringify({
      type: "choice_answer",
      promptId: choicePrompt.promptId,
      answers: [{ question: "Which approach?", selected: ["Rewrite from scratch"] }],
    }),
  );

  const secondTurnMessages = await collectUntil(socket, (message) => message.type === "turn_complete");

  const resolved = secondTurnMessages.find((message) => message.type === "choice_resolved") as
    | { type: string; promptId: string }
    | undefined;
  assert.deepEqual(resolved, { type: "choice_resolved", promptId: choicePrompt.promptId });

  const syntheticPrompt = secondTurnMessages.find(
    (message) => message.type === "claude_event" && (message.event as { type?: string }).type === "user_prompt",
  );
  assert.equal(
    ((syntheticPrompt!.event as { message?: { content?: { text?: string }[] } }).message?.content?.[0])?.text,
    "Rewrite from scratch",
  );

  const secondTurnComplete = secondTurnMessages.at(-1);
  assert.deepEqual(secondTurnComplete, { type: "turn_complete", stopped: false });

  delete process.env.FAKE_CLAUDE_REPLY;
  socket.close();
});
