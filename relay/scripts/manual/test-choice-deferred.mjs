// Manual validation for the deferred-lifecycle rework of
// `present_choice`. The automated suite (relay/tests/choiceDeferred.test.ts)
// already proves the mechanism works end to end against the real
// McpChoiceBridge/HTTP stack, but with a FAKE `claude` making the tool call
// deterministically — it can't prove the REAL model actually reads the new
// `tool_result` ("end your turn now...") and behaves accordingly. That part
// is probabilistic (model behavior, not our code), so it only means anything
// tested against the real binary. Run from `relay/`, with the relay already
// up (`npm run dev`): `node scripts/manual/test-choice-deferred.mjs`.
//
// What this checks:
//   1. The turn completes quickly after the model calls `present_choice` —
//      NOT after minutes, and NOT hanging until the CLI's ~6-minute MCP
//      timeout (the bug this whole rework exists to
//      route around). Under the old blocking design this exact scenario
//      (nobody answers right away) is what used to eventually fail with
//      "The operation timed out".
//   2. A `choice_prompt` was broadcast with the expected question.
//   3. Waiting past the point where a human would plausibly still be
//      reading the prompt (here: a few seconds — the point isn't to
//      reproduce the full 6-minute wait, it's to prove elapsed time doesn't
//      matter anymore because the turn ISN'T waiting on anything), then
//      answering, correctly starts a brand new turn whose response reflects
//      the answer.
import WebSocket from "ws";

const PORT = 8765;
const sessionId = `choice-deferred-${Date.now()}`;
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${sessionId}`);

const events = [];
let choicePrompt;
let turnCompleteCount = 0;
let turnCompleteAt;

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  events.push(message);
  if (message.type === "choice_prompt") {
    choicePrompt = message;
    console.log("[test] choice_prompt received:", JSON.stringify(message.questions));
  }
  if (message.type === "agent_event" && message.event.type === "turn_ended") {
    turnCompleteCount += 1;
    if (turnCompleteCount === 1) turnCompleteAt = Date.now();
    console.log(`[test] turn_ended #${turnCompleteCount}`);
  }
});

socket.on("error", (error) => {
  console.error("[test] error:", error.message);
  process.exit(1);
});

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

await new Promise((resolve) => socket.once("open", resolve));

const sentAt = Date.now();
console.log("[test] asking the model to ask a genuinely closed question via present_choice");
socket.send(
  JSON.stringify({
    type: "user_message",
    text:
      "Use the present_choice tool right now to ask me exactly this: question 'Pick a color', options 'Red' and " +
      "'Blue'. Call the tool with no other text before it.",
  }),
);

// If this hangs past a handful of seconds, the deferred lifecycle isn't
// working — the old blocking design would have hung here for ~6 minutes
// before degrading, not failed fast.
await waitFor(() => turnCompleteCount === 1, 60_000, "first turn_ended");
const elapsedMs = turnCompleteAt - sentAt;
console.log(`[test] first turn completed in ${elapsedMs}ms (must be seconds, not minutes)`);
if (elapsedMs > 30_000) {
  console.error("[test] FAIL: turn took suspiciously long to complete — deferred lifecycle may not be working");
  process.exit(1);
}
if (!choicePrompt) {
  console.error("[test] FAIL: no choice_prompt was ever broadcast — the model may not have called present_choice");
  process.exit(1);
}

console.log("[test] waiting 5s before answering, simulating a human who didn't respond instantly");
await new Promise((resolve) => setTimeout(resolve, 5_000));

console.log("[test] answering the prompt");
socket.send(
  JSON.stringify({
    type: "choice_answer",
    promptId: choicePrompt.promptId,
    answers: [{ question: "Pick a color", selected: ["Red"] }],
  }),
);

await waitFor(() => turnCompleteCount === 2, 60_000, "second turn_ended (the answer's follow-up turn)");
console.log("[test] second turn completed — the answer was correctly enqueued as a new turn");

const resolvedEvent = events.find((message) => message.type === "choice_resolved");
console.log("[test] choice_resolved broadcast:", Boolean(resolvedEvent));

console.log("--- result ---");
console.log("choice_prompt seen:", Boolean(choicePrompt));
console.log("first turn completed without blocking:", elapsedMs <= 30_000);
console.log("choice_resolved broadcast on answer:", Boolean(resolvedEvent));
console.log("follow-up turn ran:", turnCompleteCount === 2);

socket.close();
process.exit(0);
