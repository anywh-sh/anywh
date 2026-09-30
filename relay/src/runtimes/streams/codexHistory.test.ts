import { test } from "node:test";
import assert from "node:assert/strict";
import { codexTurnsToEvents } from "./codexHistory.js";

// A real turn from `thread/turns/list` (codex-cli 0.154.0, itemsView "full"),
// ids and paths shortened.
const REAL_TURN = {
  id: "t1",
  items: [
    { type: "userMessage", id: "u", clientId: null, content: [{ type: "text", text: "Run sed, then edit f.txt", text_elements: [] }] },
    { type: "agentMessage", id: "a1", text: "On it.", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
    {
      type: "commandExecution",
      id: "c1",
      command: "/usr/bin/bash -lc 'sed -n 2,3p f.txt'",
      cwd: "/w",
      status: "completed",
      commandActions: [{ type: "read", command: "sed -n '2,3p' f.txt", name: "f.txt", path: "/w/f.txt" }],
      aggregatedOutput: "two\nthree\n",
      exitCode: 0,
      durationMs: 0,
    },
    { type: "reasoning", id: "r1", summary: [], content: [] },
    {
      type: "fileChange",
      id: "p1",
      status: "completed",
      changes: [
        { path: "/w/f.txt", kind: { type: "update", move_path: null }, diff: "@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n" },
        { path: "/w/g.txt", kind: { type: "add" }, diff: "hello\n" },
      ],
    },
    { type: "agentMessage", id: "a2", text: "done", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  ],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 1_790_780_875,
  completedAt: 1_790_780_888,
  durationMs: 12_932,
};

test("a stored turn replays as the events a live one produced", () => {
  const events = codexTurnsToEvents([REAL_TURN]);
  assert.deepEqual(
    events.map((e) => (e.type === "tool_started" || e.type === "tool_ended" ? `${e.type}:${e.toolUseId}` : e.type)),
    [
      "turn_started",
      "user_message",
      "text",
      "tool_started:c1",
      "tool_ended:c1",
      "thinking",
      "tool_started:p1#0",
      "tool_started:p1#1",
      "tool_ended:p1#0",
      "tool_ended:p1#1",
      "text",
      "turn_ended",
    ],
  );
  assert.deepEqual(events[0], { type: "turn_started", startedAt: 1_790_780_875_000 });
  assert.deepEqual(events[1], { type: "user_message", text: "Run sed, then edit f.txt", timestamp: new Date(1_790_780_875_000).toISOString() });
  assert.deepEqual(events.at(-1), { type: "turn_ended", stopped: false, durationMs: 12_932 });
});

test("a replayed read keeps its subject and outcome", () => {
  const events = codexTurnsToEvents([REAL_TURN]);
  const started = events.find((e) => e.type === "tool_started" && e.toolUseId === "c1");
  const ended = events.find((e) => e.type === "tool_ended" && e.toolUseId === "c1");
  assert.deepEqual(started?.type === "tool_started" && started.subject, { kind: "read", path: "/w/f.txt", range: { start: 2, end: 3 } });
  assert.deepEqual(ended?.type === "tool_ended" && ended.outcome, { kind: "code", path: "/w/f.txt", lines: ["two", "three"], startLine: 2 });
});

test("an interrupted turn ends as stopped, and a turn with no timing degrades to none", () => {
  const events = codexTurnsToEvents([{ status: "interrupted", items: [] }]);
  assert.deepEqual(events, [{ type: "turn_started" }, { type: "turn_ended", stopped: true }]);
});

test("a user message with no text (an image-only prompt) is skipped, and unknown items don't throw", () => {
  const events = codexTurnsToEvents([{ status: "completed", items: [{ type: "userMessage", content: [{ type: "image", url: "x" }] }, { type: "sleep", id: "s" }] }]);
  assert.deepEqual(events, [{ type: "turn_started" }, { type: "turn_ended", stopped: false }]);
});
