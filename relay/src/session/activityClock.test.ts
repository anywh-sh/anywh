import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityClock } from "./activityClock.js";

function fakeClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

test("turn start and end carry the relay's clock and the measured duration", () => {
  const clock = fakeClock(1_000);
  const activity = new ActivityClock(clock.now);
  assert.deepEqual(activity.turnStarted(), { type: "turn_started", startedAt: 1_000 });
  clock.advance(12_400);
  assert.deepEqual(activity.turnEnded(false), { type: "turn_ended", stopped: false, durationMs: 12_400 });
});

test("a tool call without timestamps gets the arrival time of each end", () => {
  const clock = fakeClock(5_000);
  const activity = new ActivityClock(clock.now);
  const started = activity.stamp({ type: "tool_started", toolUseId: "a", name: "Bash", kind: "shell", input: {} });
  clock.advance(1_800);
  const ended = activity.stamp({ type: "tool_ended", toolUseId: "a", content: "", isError: false });
  assert.equal(started.type === "tool_started" && started.startedAt, 5_000);
  assert.equal(ended.type === "tool_ended" && ended.endedAt, 6_800);
});

test("timestamps a def already reported are never overwritten", () => {
  const clock = fakeClock(9_999);
  const activity = new ActivityClock(clock.now);
  const started = activity.stamp({ type: "tool_started", toolUseId: "a", name: "x", kind: "shell", input: {}, startedAt: 42 });
  const ended = activity.stamp({ type: "tool_ended", toolUseId: "a", content: "", isError: false, endedAt: 43 });
  assert.equal(started.type === "tool_started" && started.startedAt, 42);
  assert.equal(ended.type === "tool_ended" && ended.endedAt, 43);
});

test("a reasoning block spans from its announced start to its commit", () => {
  const clock = fakeClock(0);
  const activity = new ActivityClock(clock.now);
  clock.advance(2_700);
  activity.stamp({ type: "thinking_started" });
  clock.advance(2_000);
  const committed = activity.stamp({ type: "thinking", thinking: "" });
  assert.deepEqual(committed, { type: "thinking", thinking: "", startedAt: 2_700, endedAt: 4_700 });
});

test("a reasoning block never announced collapses to its arrival instead of borrowing an older start", () => {
  const clock = fakeClock(0);
  const activity = new ActivityClock(clock.now);
  activity.stamp({ type: "thinking_started" });
  clock.advance(1_000);
  activity.stamp({ type: "thinking", thinking: "first" });
  clock.advance(3_000);
  const second = activity.stamp({ type: "thinking", thinking: "second" });
  assert.deepEqual(second, { type: "thinking", thinking: "second", startedAt: 4_000, endedAt: 4_000 });
});

test("events with no timing of their own pass through untouched", () => {
  const activity = new ActivityClock(() => 1);
  const event = { type: "text", text: "hi" } as const;
  assert.equal(activity.stamp(event), event);
});
