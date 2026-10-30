/**
 * The arithmetic behind a plan usage meter, on plain numbers: what color a
 * window's percentage is, where the "expected pace" mark sits, where the
 * daily cuts of a weekly window fall. Kept apart from the wire model on
 * purpose — none of this needs to know which agent or account a window
 * belongs to, and all of it is what a reviewer wants to see tested.
 */

/** From here up to just under the limit, a window reads as "near the limit". */
export const WARN_PERCENT = 80;
/** A window at this percentage is spent: the agent refuses work until it resets. */
export const LIMIT_PERCENT = 100;

export type UsageLevel = "neutral" | "warn" | "limited";

const MINUTES_PER_DAY = 24 * 60;
const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

/** A whole percentage in 0..100. Anything unreadable counts as nothing used:
 * a meter has to render something, and an empty bar is the honest reading
 * of "no number". */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LIMIT_PERCENT, Math.max(0, Math.round(value)));
}

/**
 * <80 neutral, 80–99 warn, 100 limited. `warning` is the agent's own "you are
 * close" flag (Claude's `allowed_warning`): it can raise a window to warn
 * below 80, never lower one, and never call it spent.
 */
export function usageLevel(percent: number, options: { warning?: boolean } = {}): UsageLevel {
  const used = clampPercent(percent);
  if (used >= LIMIT_PERCENT) return "limited";
  if (used >= WARN_PERCENT || options.warning) return "warn";
  return "neutral";
}

/** A window whose reset time has passed: its last percentage belongs to the
 * previous window, not to this one. */
export function isWindowExpired(resetsAtMs: number, nowMs: number): boolean {
  return Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs;
}

/** The percentage to show: an expired window has used nothing of the next
 * one yet, whatever the last reading said. */
export function effectivePercent(percent: number, resetsAtMs: number, nowMs: number): number {
  return isWindowExpired(resetsAtMs, nowMs) ? 0 : clampPercent(percent);
}

/**
 * Where usage would be if it were spread evenly across the window — the share
 * of the window's time already gone, as a whole percentage. `null` when it
 * can't be placed: no duration, no reset time, or a reset further away than
 * the window is long (a clock or a reading that doesn't add up).
 */
export function expectedPace(durationMins: number, resetsAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(durationMins) || durationMins <= 0 || !Number.isFinite(resetsAtMs)) return null;
  const durationMs = durationMins * 60_000;
  const elapsed = nowMs - (resetsAtMs - durationMs);
  if (elapsed < 0) return null;
  return clampPercent((elapsed / durationMs) * 100);
}

/** The pace mark says "you are ahead/behind"; on a spent window there is
 * nothing left to be ahead of, so it goes. */
export function showsPaceMark(percent: number): boolean {
  return clampPercent(percent) < LIMIT_PERCENT;
}

/**
 * Positions (percent of the bar) of the 1px cuts that split a weekly window
 * into its seven days — six cuts. Only the weekly window gets them: a 30-day
 * bar cut 29 times is a texture, not a scale. ±1 minute, the same slack the
 * relay allows when it classifies a window by duration.
 */
export function dailyCuts(durationMins: number): number[] {
  if (Math.abs(durationMins - WEEK_MINUTES) > 1) return [];
  return [1, 2, 3, 4, 5, 6].map((day) => (day / 7) * 100);
}

/**
 * A window's short label from its length: 300 → "5h", 10080 → "7d", and both
 * 30-day lengths a provider reports (43200, 44640) → "30d". Anything else
 * reads as its largest whole unit, so a window nobody planned for still gets
 * a sensible name. Unit letters are the same in every language this app
 * ships, hence no dictionary.
 */
export function windowLabel(durationMins: number): string {
  const minutes = Math.round(durationMins);
  if (minutes === 43200 || minutes === 44640) return "30d";
  if (minutes > 0 && minutes % MINUTES_PER_DAY === 0) return `${String(minutes / MINUTES_PER_DAY)}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${String(minutes / 60)}h`;
  return `${String(Math.max(0, minutes))}m`;
}
