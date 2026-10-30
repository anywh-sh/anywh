import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_RECENCY_MS,
  BACKOFF_MAX_MS,
  CLAUDE_PROBE_INTERVAL_MS,
  activityThreshold,
  backoffDelay,
  decideClaudeAuto,
  decideCodexAuto,
  nextClaudeAutoRefreshAt,
  nextCodexAutoRefreshAt,
  type ClaudeAutoContext,
} from "./scheduler.js";
import type { RuntimePlanUsage } from "./types.js";

const NOW = 1_793_320_000_000;
const MIN = 60_000;

function claude(resetsAt: number | null, overrides: Partial<RuntimePlanUsage> = {}): RuntimePlanUsage {
  return { runtime: "claude", status: "ok", windows: [{ durationMins: 300, usedPercent: 40, resetsAt }], observedAt: NOW - 10 * MIN, ...overrides };
}

function ctx(overrides: Partial<ClaudeAutoContext> = {}): ClaudeAutoContext {
  return {
    now: NOW,
    clients: 1,
    inFlight: false,
    turnActive: false,
    lastReadingAt: NOW - 10 * MIN,
    backoffUntil: null,
    probeEnabled: true,
    usage: claude(NOW + 2 * 60 * MIN),
    localActivity: false,
    ...overrides,
  };
}

test("claude: probes every 4 min with an active window and a client", () => {
  assert.equal(decideClaudeAuto(ctx()), "probe");
  assert.equal(decideClaudeAuto(ctx({ lastReadingAt: NOW - CLAUDE_PROBE_INTERVAL_MS + 1 })), "skip");
  assert.equal(decideClaudeAuto(ctx({ lastReadingAt: NOW - CLAUDE_PROBE_INTERVAL_MS })), "probe");
});

// The invariant: no automatic probe may open a 5h window.
test("claude: never probes on its own with the window expired, at its edge, or unknown", () => {
  for (const usage of [
    claude(NOW - 1),
    claude(NOW),
    claude(NOW + MIN),
    claude(null),
    undefined,
    { runtime: "claude", status: "unknown", windows: [], observedAt: null } satisfies RuntimePlanUsage,
    claude(NOW + 2 * 60 * MIN, { observedAt: null }),
  ]) {
    assert.equal(decideClaudeAuto(ctx({ usage, lastReadingAt: null })), "skip", JSON.stringify(usage));
    assert.equal(decideClaudeAuto(ctx({ usage, lastReadingAt: null, onConnect: true })), "skip");
  }
});

test("claude: limited stops until the reset, even with local activity", () => {
  const limited = claude(NOW + 30 * MIN, { status: "limited", windows: [{ durationMins: 300, usedPercent: 100, resetsAt: NOW + 30 * MIN }] });
  assert.equal(decideClaudeAuto(ctx({ usage: limited })), "skip");
  assert.equal(decideClaudeAuto(ctx({ usage: limited, localActivity: true })), "skip");
});

test("claude: no client, kill switch, turn running, read in flight or backoff all skip", () => {
  assert.equal(decideClaudeAuto(ctx({ clients: 0 })), "skip");
  assert.equal(decideClaudeAuto(ctx({ probeEnabled: false })), "skip");
  assert.equal(decideClaudeAuto(ctx({ turnActive: true })), "skip");
  assert.equal(decideClaudeAuto(ctx({ inFlight: true })), "skip");
  assert.equal(decideClaudeAuto(ctx({ backoffUntil: NOW + 1 })), "skip");
  assert.equal(decideClaudeAuto(ctx({ backoffUntil: NOW })), "probe");
});

test("claude: a new connection never shortens the 4-min cadence; Codex's connect floor is configurable", () => {
  assert.equal(decideClaudeAuto(ctx({ onConnect: true, lastReadingAt: NOW - MIN })), "skip");
  assert.equal(decideClaudeAuto(ctx({ onConnect: true, lastReadingAt: NOW - CLAUDE_PROBE_INTERVAL_MS })), "probe");
  const codex = { now: NOW, clients: 1, inFlight: false, turnActive: false, backoffUntil: null, onConnect: true };
  assert.equal(decideCodexAuto({ ...codex, lastReadingAt: NOW - 20_000, connectFloorMs: 30_000 }), "skip");
  assert.equal(decideCodexAuto({ ...codex, lastReadingAt: NOW - 30_000, connectFloorMs: 30_000 }), "read");
});

test("claude: with the window expired, local activity (a window already open) probes", () => {
  const expired = claude(NOW - 10 * MIN);
  assert.equal(decideClaudeAuto(ctx({ usage: expired, localActivity: true })), "probe");
  assert.equal(decideClaudeAuto(ctx({ usage: expired, localActivity: true, clients: 0 })), "skip");
  assert.equal(decideClaudeAuto(ctx({ usage: { ...expired, status: "signed_out" }, localActivity: true })), "skip");
  assert.equal(decideClaudeAuto(ctx({ usage: { ...expired, status: "no_subscription" }, localActivity: true })), "skip");
});

test("activity threshold: after the last known reset and within the last 10 min; none without a known reset", () => {
  assert.equal(activityThreshold(claude(NOW - 2 * MIN), NOW), NOW - 2 * MIN);
  assert.equal(activityThreshold(claude(NOW - 60 * MIN), NOW), NOW - ACTIVITY_RECENCY_MS);
  assert.equal(activityThreshold(undefined, NOW), null);
  assert.equal(activityThreshold({ runtime: "claude", status: "unknown", windows: [], observedAt: null }, NOW), null);
  assert.equal(activityThreshold(claude(null), NOW), null);
});

// D1b: local activity is never a reason to probe a profile nothing has been
// read for — the write says a window was open then, not that it still is.
test("claude: with no known reset, local activity never probes", () => {
  for (const usage of [undefined, { runtime: "claude", status: "unknown", windows: [], observedAt: null } satisfies RuntimePlanUsage, claude(null)]) {
    assert.equal(decideClaudeAuto(ctx({ usage, localActivity: true, lastReadingAt: null })), "skip", JSON.stringify(usage));
    assert.equal(decideClaudeAuto(ctx({ usage, localActivity: true, lastReadingAt: null, onConnect: true })), "skip");
  }
});

test("codex: reads every minute with a client, never without", () => {
  const base = { now: NOW, clients: 1, inFlight: false, turnActive: false, lastReadingAt: NOW - MIN, backoffUntil: null };
  assert.equal(decideCodexAuto(base), "read");
  assert.equal(decideCodexAuto({ ...base, lastReadingAt: NOW - 59_000 }), "skip");
  assert.equal(decideCodexAuto({ ...base, lastReadingAt: null }), "read");
  assert.equal(decideCodexAuto({ ...base, clients: 0 }), "skip");
  assert.equal(decideCodexAuto({ ...base, inFlight: true }), "skip");
  assert.equal(decideCodexAuto({ ...base, backoffUntil: NOW + 1 }), "skip");
});

test("backoff doubles from 1 min up to 15 min", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffDelay), [0, MIN, 2 * MIN, 4 * MIN, 8 * MIN, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
});

test("next automatic read: null when stopped", () => {
  const base = { now: NOW, clients: 1, lastReadingAt: NOW - MIN, backoffUntil: null, probeEnabled: true };
  assert.equal(nextClaudeAutoRefreshAt({ ...base, usage: claude(NOW + 60 * MIN) }), NOW + 3 * MIN);
  assert.equal(nextClaudeAutoRefreshAt({ ...base, usage: claude(NOW - 1) }), null);
  assert.equal(nextClaudeAutoRefreshAt({ ...base, clients: 0, usage: claude(NOW + 60 * MIN) }), null);
  assert.equal(nextClaudeAutoRefreshAt({ ...base, probeEnabled: false, usage: claude(NOW + 60 * MIN) }), null);
  assert.equal(nextCodexAutoRefreshAt(base), NOW);
  assert.equal(nextCodexAutoRefreshAt({ ...base, lastReadingAt: NOW - 30_000 }), NOW + 30_000);
  assert.equal(nextCodexAutoRefreshAt({ ...base, clients: 0 }), null);
});
