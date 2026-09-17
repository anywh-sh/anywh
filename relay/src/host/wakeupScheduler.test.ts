import { test } from "node:test";
import assert from "node:assert/strict";
import { decideScheduleWakeupOutcome } from "./wakeupScheduler.js";

// ---- decideScheduleWakeupOutcome ---------------------------------------

test("decideScheduleWakeupOutcome: isError discards regardless of input (the harness itself rejected the call)", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 60, prompt: "keep going" }, true), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: isError discards even when stop is true", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ stop: true }, true), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: stop: true cancels", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ stop: true }, false), { kind: "cancel" });
});

test("decideScheduleWakeupOutcome: stop: true cancels even with a delaySeconds/prompt also present", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ stop: true, delaySeconds: 60, prompt: "keep going" }, false), { kind: "cancel" });
});

test("decideScheduleWakeupOutcome: a valid delaySeconds/prompt arms", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 120, prompt: "keep going on the loop task" }, false), {
    kind: "arm",
    delaySeconds: 120,
    prompt: "keep going on the loop task",
  });
});

test("decideScheduleWakeupOutcome: noop/reason fields are ignored without affecting the outcome", () => {
  assert.deepEqual(
    decideScheduleWakeupOutcome({ delaySeconds: 60, prompt: "keep going", noop: false, reason: "watching CI" }, false),
    { kind: "arm", delaySeconds: 60, prompt: "keep going" },
  );
});

test("decideScheduleWakeupOutcome: missing delaySeconds discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ prompt: "keep going" }, false), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: missing prompt discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 60 }, false), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: NaN delaySeconds discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: Number.NaN, prompt: "keep going" }, false), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: Infinity delaySeconds discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: Number.POSITIVE_INFINITY, prompt: "keep going" }, false), {
    kind: "discard",
  });
});

test("decideScheduleWakeupOutcome: zero or negative delaySeconds discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 0, prompt: "keep going" }, false), { kind: "discard" });
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: -5, prompt: "keep going" }, false), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: non-string prompt discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 60, prompt: 123 }, false), { kind: "discard" });
});

test("decideScheduleWakeupOutcome: empty/whitespace-only prompt discards", () => {
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 60, prompt: "" }, false), { kind: "discard" });
  assert.deepEqual(decideScheduleWakeupOutcome({ delaySeconds: 60, prompt: "   " }, false), { kind: "discard" });
});
