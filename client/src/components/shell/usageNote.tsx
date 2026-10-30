import type { Dictionary } from "@/i18n";
import type { RuntimeNote } from "@/lib/planUsage/derive";
import { cn } from "@/lib/utils";

type UsageStrings = Dictionary["shell"]["usage"];

/** The words for an agent with no windows to draw (`runtimeNote`). */
export function noteText(note: RuntimeNote, strings: UsageStrings): string {
  switch (note) {
    case "reading":
      return strings.reading;
    case "signedOut":
      return strings.signedOut;
    case "apiKey":
      return strings.apiKey;
    case "errorNetwork":
      return strings.errorNetwork;
    case "errorAuth":
      return strings.errorAuth;
    case "errorParse":
      return strings.errorParse;
    case "error":
      return strings.readError;
    case "notRead":
      return strings.noData;
  }
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
