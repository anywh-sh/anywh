import { test } from "node:test";
import assert from "node:assert/strict";
import { findEditTarget, pageHistoryBefore } from "./historyPaging.js";
import type { BroadcastMessage } from "./sharedSession.js";

function userPrompt(text: string): BroadcastMessage {
  return { type: "claude_event", event: { type: "user_prompt", message: { content: [{ type: "text", text }] } } };
}

function assistantText(text: string): BroadcastMessage {
  return { type: "claude_event", event: { type: "assistant", message: { content: [{ type: "text", text }] } } };
}

const turnComplete: BroadcastMessage = { type: "turn_complete", stopped: false };
const turnError: BroadcastMessage = { type: "turn_error", message: "something went wrong" };

/** N complete turns, each with 2 events + terminator (3 messages per turn)
 * — enough to exercise cutting in the middle of several turns. */
function buildTurns(n: number): BroadcastMessage[] {
  const history: BroadcastMessage[] = [];
  for (let i = 0; i < n; i++) {
    history.push(userPrompt(`question ${i}`), assistantText(`answer ${i}`), turnComplete);
  }
  return history;
}

test("empty history: empty page, nothing else to fetch", () => {
  const page = pageHistoryBefore([], 0, 20);
  assert.deepEqual(page, { messages: [], cursor: 0, hasMore: false });
});

test("fewer turns than the ceiling: sends everything, hasMore false (identical behavior to the old replay)", () => {
  const history = buildTurns(5);
  const page = pageHistoryBefore(history, history.length, 20);
  assert.deepEqual(page.messages, history);
  assert.equal(page.cursor, 0);
  assert.equal(page.hasMore, false);
});

test("exactly the turn ceiling: still sends everything, hasMore false (limit isn't off-by-one)", () => {
  const history = buildTurns(20);
  const page = pageHistoryBefore(history, history.length, 20);
  assert.deepEqual(page.messages, history);
  assert.equal(page.hasMore, false);
});

test("more turns than the ceiling: sends only the tail, hasMore true, cursor at the start of the right turn", () => {
  const history = buildTurns(25);
  const page = pageHistoryBefore(history, history.length, 20);
  assert.equal(page.hasMore, true);
  // The 20 most recent turns are turns 5..24 (0-indexed) — each turn has 3
  // messages, so turn 5 starts at index 15.
  assert.equal(page.cursor, 15);
  assert.deepEqual(page.messages, history.slice(15));
  assert.deepEqual(page.messages[0], userPrompt("question 5"));
});

test("turn in progress (no terminator at the end) is included in the page as the most recent turn", () => {
  const history = [...buildTurns(3), userPrompt("question in progress"), assistantText("partial answer")];
  const page = pageHistoryBefore(history, history.length, 20);
  assert.deepEqual(page.messages, history);
  assert.equal(page.hasMore, false);
});

test("turn_error also closes a turn, just like turn_complete", () => {
  const history = [userPrompt("p1"), assistantText("r1"), turnError, userPrompt("p2"), assistantText("r2"), turnComplete];
  const page = pageHistoryBefore(history, history.length, 1);
  assert.equal(page.cursor, 3);
  assert.deepEqual(page.messages, history.slice(3));
});

test("load_older_history: one page's cursor fetches the previous page, without overlapping or skipping a turn", () => {
  const history = buildTurns(45);
  const first = pageHistoryBefore(history, history.length, 20);
  assert.equal(first.hasMore, true);

  const second = pageHistoryBefore(history, first.cursor, 20);
  assert.equal(second.hasMore, true); // still 5 turns left (45 - 20 - 20)
  assert.deepEqual(second.messages, history.slice(second.cursor, first.cursor));

  const third = pageHistoryBefore(history, second.cursor, 20);
  assert.equal(third.hasMore, false); // the remaining 5 turns, from the start
  assert.equal(third.cursor, 0);
  assert.deepEqual([...third.messages, ...second.messages, ...first.messages], history);
});

function syntheticBackgroundJobPrompt(label: string): BroadcastMessage {
  return {
    type: "claude_event",
    event: { type: "user_prompt", synthetic: "background_job", label, message: { content: [{ type: "text", text: "..." }] } },
  };
}

test("findEditTarget: fromEnd 1 finds the last message, cutIndex at the start of the turn", () => {
  const history = buildTurns(3);
  const target = findEditTarget(history, 1);
  assert.deepEqual(target, { cutIndex: 6, turnsBefore: 2 });
});

test("findEditTarget: larger fromEnd counts older turns", () => {
  const history = buildTurns(3);
  const target = findEditTarget(history, 3);
  assert.deepEqual(target, { cutIndex: 0, turnsBefore: 0 });
});

test("findEditTarget: fromEnd beyond what exists returns undefined (invalid request)", () => {
  const history = buildTurns(3);
  assert.equal(findEditTarget(history, 4), undefined);
  assert.equal(findEditTarget([], 1), undefined);
});

test("findEditTarget: skips synthetic anywh-bg turns when counting from the end", () => {
  const history = [
    ...buildTurns(2), // real turn 0, real turn 1
    syntheticBackgroundJobPrompt("job x"),
    assistantText("job summary"),
    turnComplete,
    userPrompt("most recent real question"),
    assistantText("answer"),
    turnComplete,
  ];
  // fromEnd=1 should find "most recent real question" (skipping the
  // synthetic turn before it), not the synthetic turn itself.
  const last = findEditTarget(history, 1);
  assert.deepEqual(history[last!.cutIndex], userPrompt("most recent real question"));
  // turnsBefore counts ALL turns before it (2 real + 1 synthetic = 3),
  // because each one becomes exactly one line in the real .jsonl.
  assert.equal(last!.turnsBefore, 3);

  // fromEnd=2 should skip the synthetic one and find real turn 1 (buildTurns).
  const secondFromEnd = findEditTarget(history, 2);
  assert.deepEqual(history[secondFromEnd!.cutIndex], userPrompt("question 1"));
  assert.equal(secondFromEnd!.turnsBefore, 1);
});
