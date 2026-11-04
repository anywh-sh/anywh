/** Longest title the store keeps. Above the generator's own cap
 * (`MAX_TITLE_CHARS`) on purpose: a name typed by hand may run longer than a
 * generated one, but nothing stored is a whole model reply — every client
 * that lists or searches sessions reads these in full. */
export const MAX_STORED_TITLE_CHARS = 120;

/** `text` cut to `max` characters plus a trailing `…`, at the last space when
 * that keeps more than half of it. Callers check the length first. */
export function cutTitle(text: string, max: number): string {
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** What `setTitle` actually stores: the title itself when it fits, else its
 * whitespace collapsed and cut so the result is at most
 * `MAX_STORED_TITLE_CHARS` long, ellipsis included. */
export function capStoredTitle(title: string): string {
  if (title.length <= MAX_STORED_TITLE_CHARS) return title;
  return cutTitle(title.replace(/\s+/g, " ").trim(), MAX_STORED_TITLE_CHARS - 1);
}

/** A title made of `text`'s first line, whitespace collapsed and cut to `max`;
 * `null` when there is nothing to salvage. */
export function firstLineTitle(text: string, max: number): string | null {
  const trimmed = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : cutTitle(trimmed, max);
}
