// When the plan usage service reads on its own (journal/99 §1.4, §12.1):
//
// - Claude: a probe is a real turn, and with the 5h window expired it would
//   open a new one. So an automatic probe needs ≥1 connected client, the
//   kill switch on, no turn running, no read in flight, an active 5h window
//   (`shouldAutoProbe`: not unknown, not limited, not within 60 s of its
//   reset) and 4 min since the last reading — or, with the window expired,
//   local activity (a transcript written after the last reset), which means
//   a window is already open. Only a write in the last 10 min counts, and
//   never without a known reset (see `activityThreshold`).
// - Codex: reading costs no quota and opens nothing. Every minute with ≥1
//   client.
// - A new connection reads what is due now, but never within 60 s of the
//   last reading.
// - A failed read backs off (1, 2, 4… up to 15 min).
//
// The refresh button bypasses all of this (service.ts); nothing else does.
//
// Pure: the clock is a parameter.
import { PROBE_EDGE_MARGIN_MS, fiveHourWindow, shouldAutoProbe } from "./ingest.js";
import type { RuntimePlanUsage } from "./types.js";

export const CLAUDE_PROBE_INTERVAL_MS = 4 * 60_000;
export const CODEX_READ_INTERVAL_MS = 60_000;
/** How often the service re-evaluates while a client is connected. */
export const SCHEDULER_TICK_MS = 60_000;
/** A new connection doesn't read again within this of the last reading. */
export const CONNECT_FLOOR_MS = 60_000;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

export interface AutoReadContext {
  now: number;
  clients: number;
  /** A read of this runtime is in flight (the lock). */
  inFlight: boolean;
  /** A turn of this runtime is running somewhere on the relay. */
  turnActive: boolean;
  /** Last reading of any source (turn, probe, read, push), epoch ms. */
  lastReadingAt: number | null;
  /** No automatic read before this, after a failure. */
  backoffUntil: number | null;
  /** A new connection asked; the floor applies instead of the interval. */
  onConnect?: boolean;
}

export interface ClaudeAutoContext extends AutoReadContext {
  /** `ANYWH_PLAN_USAGE_PROBE` is not `0`. */
  probeEnabled: boolean;
  usage: RuntimePlanUsage | undefined;
  /** A Claude transcript of this profile was written after
   * `activityThreshold(...)`. Only consulted with the window expired. */
  localActivity: boolean;
}

function commonBlock(ctx: AutoReadContext): boolean {
  return ctx.clients <= 0 || ctx.inFlight || (ctx.backoffUntil !== null && ctx.backoffUntil > ctx.now);
}

function due(ctx: AutoReadContext, intervalMs: number): boolean {
  if (ctx.lastReadingAt === null) return true;
  return ctx.now - ctx.lastReadingAt >= (ctx.onConnect ? CONNECT_FLOOR_MS : intervalMs);
}

/** Whether the 5h window is known and active, with the edge margin. */
export function claudeWindowActive(usage: RuntimePlanUsage | undefined, now: number): boolean {
  const window = usage ? fiveHourWindow(usage) : undefined;
  return window?.resetsAt != null && window.resetsAt - PROBE_EDGE_MARGIN_MS > now;
}

/** How recent a transcript write must be to count as local activity. A
 * write only says a window was open *at that moment*: the window may have
 * started almost 5 h earlier and ended since. Keeping this short bounds that
 * case to "the window ended within the last few minutes with no use since". */
export const ACTIVITY_RECENCY_MS = 10 * 60_000;

/**
 * The instant after which a Claude transcript write counts as local use the
 * relay hasn't seen: after the last known 5h reset, and within the last
 * `ACTIVITY_RECENCY_MS`. Null when no reset is known (nothing read yet, or a
 * reading without a 5h window): then local activity never probes — only a
 * turn or the button reads.
 */
export function activityThreshold(usage: RuntimePlanUsage | undefined, now: number): number | null {
  const lastReset = usage ? fiveHourWindow(usage)?.resetsAt : undefined;
  if (lastReset == null) return null;
  return Math.max(lastReset, now - ACTIVITY_RECENCY_MS);
}

export type ClaudeAutoDecision = "probe" | "skip";

export function decideClaudeAuto(ctx: ClaudeAutoContext): ClaudeAutoDecision {
  if (!ctx.probeEnabled || ctx.turnActive || commonBlock(ctx)) return "skip";
  if (shouldAutoProbe(ctx.usage, ctx.now)) return due(ctx, CLAUDE_PROBE_INTERVAL_MS) ? "probe" : "skip";
  // Expired window: only new local use, which has opened one already. A
  // limited account inside its window, or a login without a plan, is left
  // alone either way.
  if (claudeWindowActive(ctx.usage, ctx.now)) return "skip";
  if (ctx.usage?.status === "no_subscription" || ctx.usage?.status === "signed_out") return "skip";
  if (activityThreshold(ctx.usage, ctx.now) === null) return "skip";
  return ctx.localActivity && due(ctx, CONNECT_FLOOR_MS) ? "probe" : "skip";
}

export function decideCodexAuto(ctx: AutoReadContext): "read" | "skip" {
  if (commonBlock(ctx)) return "skip";
  return due(ctx, CODEX_READ_INTERVAL_MS) ? "read" : "skip";
}

/** Delay before the next automatic read after `failures` failures in a row. */
export function backoffDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/** When the next automatic read is expected, for the client; null when
 * stopped (no client, kill switch, expired window, limited account). */
export function nextClaudeAutoRefreshAt(ctx: Omit<ClaudeAutoContext, "inFlight" | "turnActive" | "localActivity" | "onConnect">): number | null {
  if (!ctx.probeEnabled || ctx.clients <= 0 || !shouldAutoProbe(ctx.usage, ctx.now)) return null;
  const at = ctx.lastReadingAt === null ? ctx.now : ctx.lastReadingAt + CLAUDE_PROBE_INTERVAL_MS;
  return Math.max(at, ctx.backoffUntil ?? 0, ctx.now);
}

export function nextCodexAutoRefreshAt(ctx: Pick<AutoReadContext, "now" | "clients" | "lastReadingAt" | "backoffUntil">): number | null {
  if (ctx.clients <= 0) return null;
  const at = ctx.lastReadingAt === null ? ctx.now : ctx.lastReadingAt + CODEX_READ_INTERVAL_MS;
  return Math.max(at, ctx.backoffUntil ?? 0, ctx.now);
}
