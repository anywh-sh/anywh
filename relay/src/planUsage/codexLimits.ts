// Codex app-server rate limits → plan windows. Shapes recorded with
// codex-cli 0.154.0 (journal/99 §2.2):
//
// - pull `account/rateLimits/read` → `{ordinaryUsageAllowed, rateLimits,
//   rateLimitsByLimitId, accountId, rateLimitUpsell, ...}`;
// - push `account/rateLimits/updated` → `{rateLimits}`: one bucket, sparse
//   (every field may be null);
// - `account/read` → `{account: null | {type:"apiKey"} |
//   {type:"chatgpt", email, planType}}`.
//
// Rules (journal/99 §2.3):
// - a window is classified by `windowDurationMins` (±1), never by being
//   `primary` or `secondary`;
// - a push merges into the last state by `limitId`: null never erases a
//   value, and a bucket with neither window is dropped;
// - only the fields below are copied out, so `email`, `accountId`,
//   `rateLimitUpsell` and the like never leave this module.
//
// Pure: no I/O, no clock.
import type { PlanUsageStatus, PlanWindow } from "./types.js";
import { clampPercent, epochSecondsToMs, isRecord, snapWindowDuration, sortWindows } from "./windows.js";

/** The bucket holding the account's own quota; other buckets are per model. */
export const CODEX_ACCOUNT_LIMIT_ID = "codex";

/** One `limitId` bucket. `windows` holds whatever `primary`/`secondary`
 * carried, keyed by duration — a slot is not an identity. A null field means
 * "not reported", which is what lets a sparse push merge without erasing. */
export interface CodexLimitBucket {
  limitId: string;
  /** Ascending by duration, at most one per duration. */
  windows: PlanWindow[];
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexRateLimits {
  ordinaryUsageAllowed: boolean | null;
  buckets: Record<string, CodexLimitBucket>;
}

export type CodexAccount = { kind: "signed_out" } | { kind: "api_key" } | { kind: "chatgpt"; planType: string | null };

function parseWindow(raw: unknown, limitId: string): PlanWindow | null {
  if (!isRecord(raw)) return null;
  const durationMins = snapWindowDuration(raw.windowDurationMins);
  const usedPercent = clampPercent(raw.usedPercent);
  if (durationMins === null || usedPercent === null) return null;
  return { durationMins, usedPercent, resetsAt: epochSecondsToMs(raw.resetsAt), limitId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One `RateLimitSnapshot` object. `limitId: null` is the account bucket. */
export function parseCodexLimitBucket(raw: unknown, fallbackLimitId = CODEX_ACCOUNT_LIMIT_ID): CodexLimitBucket | null {
  if (!isRecord(raw)) return null;
  const limitId = stringOrNull(raw.limitId) ?? fallbackLimitId;
  return {
    limitId,
    windows: uniqueByDuration([parseWindow(raw.primary, limitId), parseWindow(raw.secondary, limitId)]),
    planType: stringOrNull(raw.planType),
    rateLimitReachedType: stringOrNull(raw.rateLimitReachedType),
  };
}

/** Drops nulls and keeps the first window of each duration (two of the
 * same length would be a malformed reply). */
function uniqueByDuration(windows: (PlanWindow | null)[]): PlanWindow[] {
  const byDuration = new Map<number, PlanWindow>();
  for (const window of windows) {
    if (window && !byDuration.has(window.durationMins)) byDuration.set(window.durationMins, window);
  }
  return sortWindows([...byDuration.values()]);
}

function hasWindow(bucket: CodexLimitBucket): boolean {
  return bucket.windows.length > 0;
}

/** The `result` of `account/rateLimits/read`. Prefers `rateLimitsByLimitId`
 * (every bucket) over `rateLimits` (the account one only). Null when the
 * result isn't an object. */
export function parseCodexRateLimitsRead(result: unknown): CodexRateLimits | null {
  if (!isRecord(result)) return null;
  const buckets: Record<string, CodexLimitBucket> = {};
  const add = (bucket: CodexLimitBucket | null) => {
    if (bucket && hasWindow(bucket)) buckets[bucket.limitId] = bucket;
  };
  if (isRecord(result.rateLimitsByLimitId)) {
    for (const [key, raw] of Object.entries(result.rateLimitsByLimitId)) add(parseCodexLimitBucket(raw, key));
  }
  if (Object.keys(buckets).length === 0) add(parseCodexLimitBucket(result.rateLimits));
  const ordinaryUsageAllowed = typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null;
  return { ordinaryUsageAllowed, buckets };
}

/** The `params` of an `account/rateLimits/updated` notification. */
export function parseCodexRateLimitsUpdated(params: unknown): CodexLimitBucket | null {
  if (!isRecord(params)) return null;
  return parseCodexLimitBucket(params.rateLimits);
}

/** Merges a pushed bucket into the last state by `limitId`, and its windows
 * by duration: a window or field the push doesn't carry keeps the previous
 * value, and a bucket that ends up with no window is not added. Returns a
 * new state; `state` is not mutated. */
export function mergeCodexRateLimits(state: CodexRateLimits, update: CodexLimitBucket): CodexRateLimits {
  const previous = state.buckets[update.limitId];
  const merged: CodexLimitBucket = {
    limitId: update.limitId,
    windows: uniqueByDuration([...update.windows, ...(previous?.windows ?? [])]),
    planType: update.planType ?? previous?.planType ?? null,
    rateLimitReachedType: update.rateLimitReachedType ?? previous?.rateLimitReachedType ?? null,
  };
  if (!hasWindow(merged)) return state;
  return { ...state, buckets: { ...state.buckets, [merged.limitId]: merged } };
}

/** The account's windows (the `codex` bucket), ascending by duration. Per
 * model buckets are left out of the first cut. */
export function codexPlanWindows(state: CodexRateLimits): PlanWindow[] {
  return state.buckets[CODEX_ACCOUNT_LIMIT_ID]?.windows ?? [];
}

/** `planType` as reported with the limits (redundant with `account/read`). */
export function codexLimitsPlanType(state: CodexRateLimits): string | null {
  return state.buckets[CODEX_ACCOUNT_LIMIT_ID]?.planType ?? null;
}

/** `limited` when the server says ordinary usage is not allowed, a limit was
 * reached, or an account window is at 100 %; `ok` otherwise. Codex has no
 * "close to the limit" signal: the UI colors by percentage. */
export function codexLimitsStatus(state: CodexRateLimits): PlanUsageStatus {
  if (state.ordinaryUsageAllowed === false) return "limited";
  const bucket = state.buckets[CODEX_ACCOUNT_LIMIT_ID];
  if (bucket?.rateLimitReachedType) return "limited";
  if (codexPlanWindows(state).some((window) => window.usedPercent >= 100)) return "limited";
  return "ok";
}

/** The `result` of `account/read`; null when the shape isn't recognized.
 * Only the plan type is kept — never the e-mail. */
export function parseCodexAccount(result: unknown): CodexAccount | null {
  if (!isRecord(result)) return null;
  const account = result.account;
  if (account === null) return { kind: "signed_out" };
  if (!isRecord(account)) return null;
  if (account.type === "apiKey") return { kind: "api_key" };
  if (account.type === "chatgpt") return { kind: "chatgpt", planType: stringOrNull(account.planType) };
  return null;
}

/** A JSON-RPC error of `account/rateLimits/read` that says something about
 * the login rather than a failure: `-32600 "codex account authentication
 * required…"` is no login, `-32600 "chatgpt authentication required…"` is an
 * API key. Null for any other error. */
export function classifyCodexRateLimitsError(error: unknown): "signed_out" | "no_subscription" | null {
  if (!isRecord(error) || error.code !== -32600 || typeof error.message !== "string") return null;
  const message = error.message.toLowerCase();
  if (message.includes("chatgpt authentication required")) return "no_subscription";
  if (message.includes("authentication required")) return "signed_out";
  return null;
}
