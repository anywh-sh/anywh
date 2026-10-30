import type { Dictionary, Locale } from "@/i18n";

/**
 * Text of the plan usage view: spans ("8s", "4m 04s", "1h 12m"), when a spent
 * window comes back ("back in 58m", "back Fri 14:00") and how old the numbers
 * are ("12s ago"). `now` is always passed in rather than read here, so the
 * caller's one clock (the view re-renders on a timer) drives every string and
 * a test can pin it.
 */

type UsageStrings = Dictionary["shell"]["usage"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * A span as its two largest units: "8s", "4m 04s", "58m", "1h 12m", "2d 5h".
 * Seconds only show under ten minutes — past that they change faster than
 * the view re-renders, and "58m 12s" reads as more precise than the numbers
 * behind it. The second unit is zero-padded so a value ticking down keeps
 * its width in a monospace column. Unit letters are the same in English and
 * Portuguese, so this needs no locale.
 */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (total < MINUTE) return `${String(Math.floor(total / SECOND))}s`;
  if (total < 10 * MINUTE) {
    return `${String(Math.floor(total / MINUTE))}m ${pad2(Math.floor((total % MINUTE) / SECOND))}s`;
  }
  if (total < HOUR) return `${String(Math.floor(total / MINUTE))}m`;
  if (total < DAY) return `${String(Math.floor(total / HOUR))}h ${pad2(Math.floor((total % HOUR) / MINUTE))}m`;
  return `${String(Math.floor(total / DAY))}d ${String(Math.floor((total % DAY) / HOUR))}h`;
}

/**
 * Weekday and time of day in the interface's language: "sex 14:00" in
 * Portuguese, "Fri 2:00 PM" in English — each locale's own clock, from
 * `Intl`. Built from parts because the joined forms carry punctuation the
 * design doesn't ("sex., 14:00"). `timeZone` exists for tests; the app
 * always shows the machine's local time.
 */
export function formatWeekdayTime(epochMs: number, locale: Locale, timeZone?: string): string {
  const date = new Date(epochMs);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(date).replace(/\.$/, "");
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  return `${weekday} ${time}`;
}

/** Day and month in the interface's language: "10/11" in Portuguese,
 * "11/10" in English. */
export function formatShortDate(epochMs: number, locale: Locale, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone }).format(new Date(epochMs));
}

/**
 * When a window resets, as the short value of a renewal column: a span while
 * it is less than a day away ("58m"), the weekday and time within the week
 * ("sex 14:00") — counting down days in hours stops meaning anything — and
 * the date beyond it ("10/11"), where a weekday would name the wrong week.
 * `null` once the reset time has passed or isn't known.
 */
export function formatResetTime(
  resetsAtMs: number,
  nowMs: number,
  locale: Locale,
  timeZone?: string,
): { kind: "in" | "on"; text: string } | null {
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) return null;
  const remaining = resetsAtMs - nowMs;
  if (remaining < DAY) return { kind: "in", text: formatSpan(remaining) };
  if (remaining < 6 * DAY) return { kind: "on", text: formatWeekdayTime(resetsAtMs, locale, timeZone) };
  return { kind: "on", text: formatShortDate(resetsAtMs, locale, timeZone) };
}

/** The same reset as a phrase: "back in 58m" / "volta sex 14:00". */
export function formatResetPhrase(
  strings: UsageStrings,
  resetsAtMs: number,
  nowMs: number,
  locale: Locale,
  timeZone?: string,
): string | null {
  const reset = formatResetTime(resetsAtMs, nowMs, locale, timeZone);
  if (!reset) return null;
  return reset.kind === "in"
    ? strings.resetsIn.replace("{duration}", reset.text)
    : strings.resetsOn.replace("{when}", reset.text);
}

/** How old a reading is: "12s ago" / "há 4m 04s", and "now" inside the first
 * second (what the refresh button lands on). A reading stamped in the future
 * (clock skew between relay and client) counts as now. */
export function formatUpdatedAgo(strings: UsageStrings, observedAtMs: number, nowMs: number): string {
  const age = nowMs - observedAtMs;
  if (!Number.isFinite(age) || age < SECOND) return strings.updatedNow;
  return strings.updatedAgo.replace("{duration}", formatSpan(age));
}
