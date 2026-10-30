import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeReadingStatus, parseClaudeRateLimitEvent } from "./claudeEvent.js";
import { CLAUDE_EVENT_ALLOWED, CLAUDE_EVENT_REJECTED, CLAUDE_EVENT_WARNING_SCOPED } from "./fixtures.js";

test("a recorded event becomes 5h and 7d windows in percent and epoch ms", () => {
  const reading = parseClaudeRateLimitEvent(CLAUDE_EVENT_ALLOWED);
  assert.deepEqual(reading, {
    claudeStatus: "allowed",
    windows: [
      { durationMins: 300, usedPercent: 63, resetsAt: 1793333400_000 },
      { durationMins: 10080, usedPercent: 19, resetsAt: 1793746800_000 },
    ],
  });
  assert.equal(claudeReadingStatus(reading), "ok");
});

test("rejected is limited, with the exhausted window at 100", () => {
  const reading = parseClaudeRateLimitEvent(CLAUDE_EVENT_REJECTED)!;
  assert.equal(reading.claudeStatus, "rejected");
  assert.equal(reading.windows[0]?.usedPercent, 100);
  assert.equal(claudeReadingStatus(reading), "limited");
});

test("allowed_warning keeps its threshold, and a scoped weekly window is its own limit", () => {
  const reading = parseClaudeRateLimitEvent(CLAUDE_EVENT_WARNING_SCOPED)!;
  assert.equal(claudeReadingStatus(reading), "warning");
  assert.equal(reading.surpassedThresholdPercent, 80);
  assert.deepEqual(
    reading.windows.map((window) => [window.durationMins, window.limitId, window.usedPercent]),
    [
      [300, undefined, 42],
      [10080, undefined, 83],
      [10080, "seven_day_opus", 91],
    ],
  );
});

test("a window at 100 is limited even when the status says allowed", () => {
  const event = structuredClone(CLAUDE_EVENT_ALLOWED);
  event.rate_limit_info.unifiedWindows.seven_day.utilization = 1;
  assert.equal(claudeReadingStatus(parseClaudeRateLimitEvent(event)!), "limited");
});

test("utilization is clamped to 0–100", () => {
  const event = structuredClone(CLAUDE_EVENT_ALLOWED);
  event.rate_limit_info.unifiedWindows.five_hour.utilization = 1.7;
  event.rate_limit_info.unifiedWindows.seven_day.utilization = -0.2;
  const reading = parseClaudeRateLimitEvent(event)!;
  assert.deepEqual(reading.windows.map((window) => window.usedPercent), [100, 0]);
});

test("a malformed or unknown window is dropped, the rest kept", () => {
  const reading = parseClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: "0.5", resetsAt: 1793333400 },
        one_minute: { utilization: 0.1, resetsAt: 1793333400 },
        seven_day: { utilization: 0.3 },
        seven_day_sonnet: null,
      },
    },
  })!;
  assert.deepEqual(reading.windows, [{ durationMins: 10080, usedPercent: 30, resetsAt: null }]);
});

test("an unknown status falls back to the windows, and is reported as null", () => {
  const event = structuredClone(CLAUDE_EVENT_ALLOWED) as { rate_limit_info: { status: string } };
  event.rate_limit_info.status = "something_new";
  const reading = parseClaudeRateLimitEvent(event)!;
  assert.equal(reading.claudeStatus, null);
  assert.equal(claudeReadingStatus(reading), "ok");
});

test("without unifiedWindows, the top-level representative window is used", () => {
  const reading = parseClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.25, resetsAt: 1793333400 },
  })!;
  assert.deepEqual(reading.windows, [{ durationMins: 300, usedPercent: 25, resetsAt: 1793333400_000 }]);
});

test("anything that isn't a rate_limit_event with an info object is null", () => {
  assert.equal(parseClaudeRateLimitEvent(null), null);
  assert.equal(parseClaudeRateLimitEvent("rate_limit_event"), null);
  assert.equal(parseClaudeRateLimitEvent({ type: "result" }), null);
  assert.equal(parseClaudeRateLimitEvent({ type: "rate_limit_event" }), null);
  assert.deepEqual(parseClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }), { claudeStatus: null, windows: [] });
});

test("ids from the event never reach the reading", () => {
  const serialized = JSON.stringify(parseClaudeRateLimitEvent(CLAUDE_EVENT_ALLOWED));
  assert.ok(!serialized.includes(CLAUDE_EVENT_ALLOWED.uuid));
  assert.ok(!serialized.includes(CLAUDE_EVENT_ALLOWED.session_id));
});
