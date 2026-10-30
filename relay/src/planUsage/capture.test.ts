import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanUsageCapture, planUsageRuntimeOf, type PlanUsageCaptureEvent } from "./capture.js";
import {
  CLAUDE_EVENT_ALLOWED,
  CLAUDE_EVENT_REJECTED,
  CLAUDE_EVENT_WARNING_SCOPED,
  CODEX_RATE_LIMITS_READ_PLUS,
  CODEX_RATE_LIMITS_UPDATED_EMPTY,
} from "./fixtures.js";

const NOW = 1_793_330_000_000;

function recording(): {
  capture: PlanUsageCapture;
  events: PlanUsageCaptureEvent[];
} {
  const capture = new PlanUsageCapture(() => NOW);
  const events: PlanUsageCaptureEvent[] = [];
  capture.subscribe((event) => events.push(event));
  return { capture, events };
}

test("a Claude rate_limit_event becomes a turn reading, stamped with the capture's clock", () => {
  const { capture, events } = recording();
  assert.equal(capture.claudeEvent(CLAUDE_EVENT_ALLOWED), true);
  assert.deepEqual(events, [
    {
      kind: "reading",
      runtime: "claude",
      reading: {
        status: "ok",
        observedAt: NOW,
        source: "turn",
        windows: [
          { durationMins: 300, usedPercent: 63, resetsAt: 1793333400_000 },
          { durationMins: 10080, usedPercent: 19, resetsAt: 1793746800_000 },
        ],
      },
    },
  ]);
});

test("rejected and allowed_warning map to limited and warning", () => {
  const { capture, events } = recording();
  capture.claudeEvent(CLAUDE_EVENT_REJECTED);
  capture.claudeEvent(CLAUDE_EVENT_WARNING_SCOPED);
  const statuses = events.map((event) => (event.kind === "reading" ? event.reading.status : event.kind));
  assert.deepEqual(statuses, ["limited", "warning"]);
});

test("any other Claude event is ignored", () => {
  const { capture, events } = recording();
  assert.equal(capture.claudeEvent({ type: "assistant", message: {} }), false);
  assert.equal(capture.claudeEvent({ type: "rate_limit_event" }), false);
  assert.equal(capture.claudeEvent(null), false);
  assert.deepEqual(events, []);
});

test("a Codex push is claimed and handed over as a bucket; other methods are not claimed", () => {
  const { capture, events } = recording();
  assert.equal(
    capture.codexNotification("account/rateLimits/updated", {
      rateLimits: CODEX_RATE_LIMITS_READ_PLUS.rateLimits,
    }),
    true,
  );
  assert.equal(capture.codexNotification("thread/tokenUsage/updated", {}), false);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.kind, "codex_push");
  if (event.kind !== "codex_push") return;
  assert.equal(event.observedAt, NOW);
  assert.equal(event.bucket.limitId, "codex");
  assert.equal(event.bucket.planType, "plus");
  assert.deepEqual(
    event.bucket.windows.map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 12],
      [10080, 40],
    ],
  );
});

test("a sparse Codex push still goes out (the merge keeps what it lacks); a malformed one is claimed but dropped", () => {
  const { capture, events } = recording();
  capture.codexNotification("account/rateLimits/updated", CODEX_RATE_LIMITS_UPDATED_EMPTY);
  assert.equal(capture.codexNotification("account/rateLimits/updated", "garbage"), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind === "codex_push" && events[0].bucket.windows.length, 0);
});

test("turn activity is counted per runtime and only its edges are announced", () => {
  const { capture, events } = recording();
  const endA = capture.turnStarted("claude");
  const endB = capture.turnStarted("claude");
  assert.equal(capture.isTurnActive("claude"), true);
  assert.equal(capture.isTurnActive("codex"), false);
  endA();
  endA();
  assert.equal(capture.isTurnActive("claude"), true, "ending the same turn twice counts once");
  endB();
  assert.equal(capture.isTurnActive("claude"), false);
  assert.deepEqual(events, [
    { kind: "turn_activity", runtime: "claude", active: true },
    { kind: "turn_activity", runtime: "claude", active: false },
  ]);
});

test("a throwing listener neither breaks the caller nor the other listeners", () => {
  const capture = new PlanUsageCapture(() => NOW);
  const seen: string[] = [];
  capture.subscribe(() => {
    throw new Error("boom");
  });
  const unsubscribe = capture.subscribe((event) => seen.push(event.kind));
  assert.doesNotThrow(() => capture.claudeEvent(CLAUDE_EVENT_ALLOWED));
  unsubscribe();
  capture.claudeEvent(CLAUDE_EVENT_ALLOWED);
  assert.deepEqual(seen, ["reading"]);
});

test("only claude and codex have a plan to read", () => {
  assert.equal(planUsageRuntimeOf("claude"), "claude");
  assert.equal(planUsageRuntimeOf("codex"), "codex");
  assert.equal(planUsageRuntimeOf("gemini"), undefined);
});
