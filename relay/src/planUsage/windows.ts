// Value helpers shared by the per-source parsers: every field they read is
// outside a documented contract (journal/99 §8), so each one is checked here
// and a bad value drops the window instead of reaching the client.
//
// Pure: no I/O, no clock.
import { PLAN_WINDOW_MINS, type PlanWindow } from "./types.js";

const CANONICAL_MINS: readonly number[] = Object.values(PLAN_WINDOW_MINS);

/** `durationMins` snapped to a canonical length when within ±1 of one;
 * null when not a positive finite number. */
export function snapWindowDuration(mins: unknown): number | null {
  if (typeof mins !== "number" || !Number.isFinite(mins) || mins <= 0) return null;
  const canonical = CANONICAL_MINS.find((value) => Math.abs(value - mins) <= 1);
  return canonical ?? Math.round(mins);
}

/** A percentage clamped to 0–100 and rounded to one decimal; null when not a
 * finite number. */
export function clampPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** An epoch timestamp from a source that reports seconds, in ms. A value
 * already in ms (≥ 1e12, i.e. past 2001 if read as ms) is kept as is; null
 * when not a positive finite number. */
export function epochSecondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1e12 ? Math.round(value) : Math.round(value * 1000);
}

/** Whether two resets name the same instant. Codex's `resetsAt` drifts by a
 * second between reads, so an exact comparison would report a change that
 * isn't one. */
export function sameResetsAt(a: number | null, b: number | null, toleranceMs = 1000): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= toleranceMs;
}

/** Identity of a window across readings: duration plus limit id. */
export function windowIdentity(window: Pick<PlanWindow, "durationMins" | "limitId">): string {
  return `${window.durationMins}:${window.limitId ?? ""}`;
}

/** Ascending by duration, then by limit id (account-wide first). */
export function sortWindows(windows: PlanWindow[]): PlanWindow[] {
  return [...windows].sort((a, b) => a.durationMins - b.durationMins || (a.limitId ?? "").localeCompare(b.limitId ?? ""));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
