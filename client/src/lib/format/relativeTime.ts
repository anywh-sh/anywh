import type { Locale } from "@/i18n";

/** Shown instead of a time when there is no usable one. Not in the
 * dictionary on purpose: it is a dash in every language, and it marks a
 * degraded state rather than copy anyone reads. */
const UNKNOWN_TIME = "—";

/**
 * "now", "2 hr. ago", "5 days ago" — after a week falls back to the absolute
 * date (`formatAbsoluteTime`): relative only makes sense while the order of
 * magnitude is obvious at a glance.
 *
 * Built on `Intl.RelativeTimeFormat` rather than on dictionary strings. The
 * grammar of a relative time is not a template with a number in it — plural
 * forms, the word order and whether a unit is even used differ per language,
 * and the platform already ships that knowledge for every locale. Keeping
 * these out of `dictionary.ts` also means adding a language never means
 * hand-writing eight more time phrases.
 */
export function formatRelativeTime(epochMs: number, locale: Locale): string {
  // A value that isn't a real instant (an older relay that doesn't send the
  // field, a corrupted cache entry) must not reach `Intl`: both formatters
  // throw `RangeError` on one, and these run during render — a single bad
  // timestamp anywhere took the whole app down with it.
  if (!Number.isFinite(epochMs)) return UNKNOWN_TIME;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSeconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  // `numeric: "auto"` turns a zero delta into the idiomatic "now"/"agora"
  // instead of "in 0 seconds".
  if (diffSeconds < 45) return relative.format(0, "second");
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return relative.format(-Math.max(1, diffMinutes), "minute");
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return relative.format(-diffHours, "hour");
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return relative.format(-diffDays, "day");
  return formatAbsoluteTime(epochMs, locale);
}

/** Full date + time — used in the relative timestamp's tooltip (hover
 * reveals the exact time) and as `formatRelativeTime`'s fallback after a
 * week. */
export function formatAbsoluteTime(epochMs: number, locale: Locale): string {
  if (!Number.isFinite(epochMs)) return UNKNOWN_TIME;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(epochMs));
}
