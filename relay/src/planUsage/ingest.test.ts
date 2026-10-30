import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROBE_EDGE_MARGIN_MS,
  emptyPlanUsage,
  ingestAuthState,
  ingestError,
  ingestReading,
  presentPlanUsage,
  shouldAutoProbe,
  type PlanUsageReading,
} from "./ingest.js";
import type { PlanWindow, RuntimePlanUsage } from "./types.js";

const T0 = 1_793_320_000_000;
const MIN = 60_000;
const FIVE_H_RESET = T0 + 3 * 60 * MIN;
const SEVEN_D_RESET = T0 + 4 * 24 * 60 * MIN;

function windows(fiveHour: number, sevenDay: number, fiveHourReset = FIVE_H_RESET): PlanWindow[] {
  return [
    { durationMins: 300, usedPercent: fiveHour, resetsAt: fiveHourReset },
    { durationMins: 10080, usedPercent: sevenDay, resetsAt: SEVEN_D_RESET },
  ];
}

function reading(overrides: Partial<PlanUsageReading> = {}): PlanUsageReading {
  return { status: "ok", windows: windows(40, 20), observedAt: T0, source: "turn", ...overrides };
}

function claudeAt(fiveHourReset: number | null, overrides: Partial<RuntimePlanUsage> = {}): RuntimePlanUsage {
  return {
    runtime: "claude",
    status: "ok",
    windows: [{ durationMins: 300, usedPercent: 40, resetsAt: fiveHourReset }],
    observedAt: T0,
    ...overrides,
  };
}

test("a first reading replaces the empty state", () => {
  const state = ingestReading(emptyPlanUsage("claude"), reading({ plan: { family: "max", label: "Max 5x" } }));
  assert.equal(state.status, "ok");
  assert.equal(state.observedAt, T0);
  assert.equal(state.source, "turn");
  assert.deepEqual(state.windows, windows(40, 20));
  assert.equal(state.plan?.label, "Max 5x");
});

test("within the same window usage only grows: a lower percentage keeps the higher one", () => {
  const first = ingestReading(emptyPlanUsage("claude"), reading());
  // Same reset ±60 s (Claude rounds the window start), lower 5h: a late, older snapshot.
  const second = ingestReading(first, reading({ windows: windows(35, 25, FIVE_H_RESET + 30_000), observedAt: T0 + MIN }));
  assert.deepEqual(
    second.windows.map((window) => window.usedPercent),
    [40, 25],
  );
  assert.equal(second.observedAt, T0 + MIN);
});

test("a new window (different reset) may start lower", () => {
  const first = ingestReading(emptyPlanUsage("claude"), reading({ windows: windows(90, 20) }));
  const next = ingestReading(first, reading({ windows: windows(2, 21, FIVE_H_RESET + 5 * 60 * MIN), observedAt: T0 + 2 * MIN }));
  assert.equal(next.windows[0]?.usedPercent, 2);
});

test("a reading older than the held one is ignored", () => {
  const held = ingestReading(emptyPlanUsage("claude"), reading({ observedAt: T0 + MIN }));
  assert.equal(ingestReading(held, reading({ windows: windows(99, 99), observedAt: T0 })), held);
});

test("windows a reading doesn't mention are kept, and the plan survives a reading without one", () => {
  const first = ingestReading(emptyPlanUsage("claude"), reading({ plan: { family: "max", label: "Max" } }));
  const next = ingestReading(first, reading({ windows: [{ durationMins: 300, usedPercent: 45, resetsAt: FIVE_H_RESET }], observedAt: T0 + MIN }));
  assert.deepEqual(
    next.windows.map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 45],
      [10080, 20],
    ],
  );
  assert.equal(next.plan?.label, "Max");
});

test("a window held at 100 makes the merged state limited", () => {
  const first = ingestReading(emptyPlanUsage("claude"), reading({ status: "limited", windows: windows(100, 20) }));
  const next = ingestReading(first, reading({ status: "ok", windows: windows(97, 20), observedAt: T0 + MIN }));
  assert.equal(next.status, "limited");
});

test("an expired window at 100 doesn't keep the state limited", () => {
  const first = ingestReading(emptyPlanUsage("claude"), reading({ status: "limited", windows: windows(100, 20) }));
  const afterReset = FIVE_H_RESET + MIN;
  const next = ingestReading(first, reading({ windows: [{ durationMins: 10080, usedPercent: 21, resetsAt: SEVEN_D_RESET }], observedAt: afterReset }));
  assert.equal(next.status, "ok");
});

test("an error keeps the last data and its age; the next reading clears it", () => {
  const good = ingestReading(emptyPlanUsage("codex"), reading({ source: "app_server_read" }));
  const failed = ingestError(good, "network");
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.error, { kind: "network" });
  assert.deepEqual(failed.windows, good.windows);
  assert.equal(failed.observedAt, good.observedAt);
  const recovered = ingestReading(failed, reading({ observedAt: T0 + MIN }));
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.error, undefined);
});

test("signing out drops the windows, plan and account key", () => {
  const good = ingestReading({ ...emptyPlanUsage("codex"), accountKey: "0123456789abcdef" }, reading({ plan: { family: "free", label: "Free" } }));
  assert.equal(good.accountKey, "0123456789abcdef");
  const out = ingestAuthState(good, "signed_out", T0 + MIN);
  assert.deepEqual(out, { runtime: "codex", status: "signed_out", windows: [], observedAt: T0 + MIN });
});

test("an expired window is presented at 0 %, never its old percentage", () => {
  const state = ingestReading(emptyPlanUsage("claude"), reading({ status: "limited", windows: windows(100, 30) }));
  const shown = presentPlanUsage(state, FIVE_H_RESET);
  assert.deepEqual(
    shown.windows.map((window) => [window.usedPercent, window.resetsAt]),
    [
      [0, FIVE_H_RESET],
      [30, SEVEN_D_RESET],
    ],
  );
  assert.equal(shown.status, "ok");
  // The stored state is not touched.
  assert.equal(state.windows[0]?.usedPercent, 100);
  // Before the reset nothing changes.
  assert.equal(presentPlanUsage(state, FIVE_H_RESET - 1), state);
});

test("presenting keeps limited while another window is still exhausted", () => {
  const state = ingestReading(emptyPlanUsage("claude"), reading({ status: "limited", windows: windows(100, 100) }));
  assert.equal(presentPlanUsage(state, FIVE_H_RESET).status, "limited");
});

test("presenting drops a warning only when every window expired", () => {
  const warning = ingestReading(emptyPlanUsage("claude"), reading({ status: "warning", windows: windows(85, 30) }));
  assert.equal(presentPlanUsage(warning, FIVE_H_RESET).status, "warning");
  assert.equal(presentPlanUsage(warning, SEVEN_D_RESET).status, "ok");
});

// The invariant the whole cadence rests on: an automatic probe never opens
// a 5h window. Every case below that answers true has an active window.
test("auto probe: only with an active 5h window, outside the edge margin", () => {
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET), T0), true);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET), FIVE_H_RESET - PROBE_EDGE_MARGIN_MS - 1), true);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET), FIVE_H_RESET - PROBE_EDGE_MARGIN_MS), false);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET), FIVE_H_RESET), false);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET), FIVE_H_RESET + 1), false);
});

test("auto probe: unknown state counts as expired", () => {
  assert.equal(shouldAutoProbe(undefined, T0), false);
  assert.equal(shouldAutoProbe(emptyPlanUsage("claude"), T0), false);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { observedAt: null }), T0), false);
  assert.equal(shouldAutoProbe(claudeAt(null), T0), false);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { windows: [{ durationMins: 10080, usedPercent: 10, resetsAt: SEVEN_D_RESET }] }), T0), false);
  // A model-scoped window is not the account's 5h window.
  assert.equal(
    shouldAutoProbe(claudeAt(FIVE_H_RESET, { windows: [{ durationMins: 300, usedPercent: 10, resetsAt: FIVE_H_RESET, limitId: "five_hour_x" }] }), T0),
    false,
  );
});

test("auto probe: never while limited, signed out or without a subscription", () => {
  for (const status of ["limited", "signed_out", "no_subscription", "unknown"] as const) {
    assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { status }), T0), false, status);
  }
  // An exhausted 5h window only changes at its reset, whatever the status says.
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { status: "error", windows: [{ durationMins: 300, usedPercent: 100, resetsAt: FIVE_H_RESET }] }), T0), false);
});

test("auto probe: a warning or a failed read with an active window may probe", () => {
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { status: "warning" }), T0), true);
  assert.equal(shouldAutoProbe(claudeAt(FIVE_H_RESET, { status: "error", error: { kind: "network" } }), T0), true);
});
