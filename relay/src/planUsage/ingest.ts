// How a new reading folds into what the relay already knows about one
// runtime's plan, and the gate that keeps an automatic Claude probe from
// opening a 5h window nobody asked for (journal/99 §1.4, §3, §12.1):
//
// - within the same window (same duration and limit, `resetsAt` within 60 s)
//   usage only grows: a lower percentage is an older snapshot arriving late;
// - a window whose `resetsAt` has passed never shows its old percentage;
// - a failed read keeps the last good data, with its age;
// - nothing is probed automatically while the 5h window is expired or
//   unknown, nor while the account is limited.
//
// Pure: the clock is always a parameter.
import {
  PLAN_WINDOW_MINS,
  type PlanLabel,
  type PlanUsageErrorKind,
  type PlanUsageRuntime,
  type PlanUsageSource,
  type PlanUsageStatus,
  type PlanWindow,
  type RuntimePlanUsage,
} from "./types.js";
import { sameResetsAt, sortWindows, windowIdentity } from "./windows.js";

/** Two readings of a window are the same window when their resets are this
 * close: Claude rounds the start of a window, Codex drifts by a second. */
export const SAME_WINDOW_TOLERANCE_MS = 60_000;

/** A window counts as expired this long before its `resetsAt`, so a probe
 * (≈2 s) never lands on the second the window turns over and opens the next
 * one. */
export const PROBE_EDGE_MARGIN_MS = 60_000;

/** A successful read from any source, already parsed. */
export interface PlanUsageReading {
  status: Extract<PlanUsageStatus, "ok" | "warning" | "limited">;
  windows: PlanWindow[];
  /** When the source produced it, epoch ms. */
  observedAt: number;
  source: PlanUsageSource;
  plan?: PlanLabel;
}

/** A runtime nothing has been read for yet. */
export function emptyPlanUsage(runtime: PlanUsageRuntime): RuntimePlanUsage {
  return { runtime, status: "unknown", windows: [], observedAt: null };
}

export function isWindowExpired(window: PlanWindow, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now;
}

function mergeWindow(previous: PlanWindow | undefined, next: PlanWindow): PlanWindow {
  if (!previous || !sameResetsAt(previous.resetsAt, next.resetsAt, SAME_WINDOW_TOLERANCE_MS)) return next;
  return next.usedPercent < previous.usedPercent ? previous : next;
}

/**
 * Folds a successful reading into `previous`. A reading older than the one
 * already held is ignored. Windows the reading doesn't mention are kept (a
 * missing field never erases), and a reading clears any previous error.
 */
export function ingestReading(previous: RuntimePlanUsage, reading: PlanUsageReading): RuntimePlanUsage {
  if (previous.observedAt !== null && reading.observedAt < previous.observedAt) return previous;

  const merged = new Map(previous.windows.map((window) => [windowIdentity(window), window]));
  for (const window of reading.windows) {
    const key = windowIdentity(window);
    merged.set(key, mergeWindow(merged.get(key), window));
  }
  const windows = sortWindows([...merged.values()]);
  const exhausted = windows.some((window) => window.usedPercent >= 100 && !isWindowExpired(window, reading.observedAt));
  const status: PlanUsageStatus = exhausted ? "limited" : reading.status;

  const next: RuntimePlanUsage = {
    runtime: previous.runtime,
    status,
    windows,
    observedAt: reading.observedAt,
    source: reading.source,
  };
  const plan = reading.plan ?? previous.plan;
  if (plan) next.plan = plan;
  if (previous.accountKey !== undefined) next.accountKey = previous.accountKey;
  if (previous.nextAutoRefreshAt !== undefined) next.nextAutoRefreshAt = previous.nextAutoRefreshAt;
  return next;
}

/** The CLI has no login, or a login without a plan: the windows and the plan
 * of the previous account no longer apply. */
export function ingestAuthState(
  previous: RuntimePlanUsage,
  status: Extract<PlanUsageStatus, "signed_out" | "no_subscription">,
  observedAt: number,
): RuntimePlanUsage {
  const next: RuntimePlanUsage = { runtime: previous.runtime, status, windows: [], observedAt };
  if (previous.nextAutoRefreshAt !== undefined) next.nextAutoRefreshAt = previous.nextAutoRefreshAt;
  return next;
}

/** A read failed: keep the last data and its `observedAt`, flag the error. */
export function ingestError(previous: RuntimePlanUsage, kind: PlanUsageErrorKind): RuntimePlanUsage {
  return { ...previous, status: "error", error: { kind } };
}

/**
 * The state as it may be shown at `now`: an expired window reads 0 % (its
 * past `resetsAt` stays, so the client can say "no active window"), and a
 * `limited`/`warning` status that only expired windows justified drops to
 * `ok`. Apply before every send — the stored state keeps the raw values.
 */
export function presentPlanUsage(usage: RuntimePlanUsage, now: number): RuntimePlanUsage {
  if (!usage.windows.some((window) => isWindowExpired(window, now))) return usage;
  const windows = usage.windows.map((window) => (isWindowExpired(window, now) ? { ...window, usedPercent: 0 } : window));
  let status = usage.status;
  if (status === "limited" && !windows.some((window) => window.usedPercent >= 100)) status = "ok";
  if (status === "warning" && windows.every((window) => isWindowExpired(window, now))) status = "ok";
  return { ...usage, windows, status };
}

/** Claude's account-wide 5h window, if known. */
export function fiveHourWindow(usage: RuntimePlanUsage): PlanWindow | undefined {
  return usage.windows.find((window) => window.durationMins === PLAN_WINDOW_MINS.fiveHour && window.limitId === undefined);
}

/**
 * Whether an automatic (timer, new connection, local activity) Claude probe
 * may run at `now`. A probe is a real turn: with the 5h window expired it
 * would open a new one, anchored at the probe instead of at real use. So it
 * runs only when the last reading shows a 5h window that is still active
 * (with `PROBE_EDGE_MARGIN_MS` to spare) and the account isn't limited.
 * Unknown state counts as expired. The refresh button (`force`) bypasses
 * this gate by design (D13); nothing else may.
 */
export function shouldAutoProbe(usage: RuntimePlanUsage | undefined, now: number): boolean {
  if (!usage || usage.observedAt === null) return false;
  if (usage.status !== "ok" && usage.status !== "warning" && usage.status !== "error") return false;
  const window = fiveHourWindow(usage);
  if (!window || window.resetsAt === null || window.usedPercent >= 100) return false;
  return window.resetsAt - PROBE_EDGE_MARGIN_MS > now;
}
