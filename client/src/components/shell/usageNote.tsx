import type { Dictionary } from "@/i18n";
import type { RuntimeNote } from "@/lib/planUsage/derive";
import { cn } from "@/lib/utils";

type UsageStrings = Dictionary["shell"]["usage"];

/** The words for an agent with no windows to draw (`runtimeNote`). A failed
 * read is one short phrase whatever its cause; the cause is `noteDetail`. */
export function noteText(note: RuntimeNote, strings: UsageStrings): string {
  switch (note) {
    case "reading":
      return strings.reading;
    case "signedOut":
      return strings.signedOut;
    case "apiKey":
      return strings.apiKey;
    case "errorNetwork":
    case "errorAuth":
    case "errorParse":
    case "error":
      return strings.readError;
    case "notRead":
      return strings.noData;
  }
}

/** The cause of a failed read, for a tooltip and the accessible name;
 * `undefined` for every other note, and for a failure of unknown cause. */
export function noteDetail(note: RuntimeNote, strings: UsageStrings): string | undefined {
  if (note === "errorNetwork") return strings.errorNetwork;
  if (note === "errorAuth") return strings.errorAuth;
  if (note === "errorParse") return strings.errorParse;
  return undefined;
}

/** `noteText`, with its cause in parentheses when there is one — for text
 * read aloud, where a tooltip doesn't reach. */
export function noteSpoken(note: RuntimeNote, strings: UsageStrings): string {
  const detail = noteDetail(note, strings);
  return detail ? `${noteText(note, strings)} (${detail})` : noteText(note, strings);
}

/**
 * A read in progress: a small ring turning — a spinner, never a pulse, so it
 * reads as "working" and not as an alert. Under reduced motion the global
 * rule in index.css stops it, and the "updating…" text beside it carries the
 * state on its own.
 */
export function ReadingMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-usage-reading
      className={cn("size-2 shrink-0 animate-spin rounded-full border border-border border-t-foreground", className)}
    />
  );
}
