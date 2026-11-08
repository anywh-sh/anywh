import { useRef } from "react";
import { RotateCw } from "lucide-react";
import { formatSpan } from "@/lib/planUsage/format";
import { cn } from "@/lib/utils";

/** Clicks on refresh closer than this are one click — per button, and, for
 * plan usage, across both buttons where the request is made (App's
 * `refreshUsage`). */
export const REFRESH_CLICK_DEBOUNCE_MS = 1_000;

export interface RefreshControlInput {
  /** A read the relay says it is running — the icon turns. Never for having
   * sent a refresh: one the relay answers from its cache comes back in
   * milliseconds, with nothing read, and a spinner would only flash. */
  reading: boolean;
  /** How long until a refresh can make the relay read again, in ms; `null`
   * when it can now (the relay answers a forced refresh from its cache until
   * its `refreshableAt`). */
  cooldownMs: number | null;
  /** How old the data shown is ("4m ago"), already in words; `null` when
   * there is none. */
  age: string | null;
  onRefresh: () => void;
  labels: {
    /** The button's name, and its title while nothing holds it. */
    refresh: string;
    /** `{duration}` until a refresh can read again. */
    againIn: string;
  };
}

/**
 * The state of a refresh button over data a relay reads on request (plan
 * usage, an integration's tickets):
 * - `held`: reading, or the relay would answer from its cache anyway; a
 *   click then does nothing.
 * - `title`: how old the data is and, while held by the floor, when a
 *   refresh can read again.
 */
export function useRefreshControl({ reading, cooldownMs, age, onRefresh, labels }: RefreshControlInput) {
  const held = reading || cooldownMs !== null;
  const lastClick = useRef(0);
  const again = cooldownMs !== null ? labels.againIn.replace("{duration}", formatSpan(cooldownMs)) : null;
  const title = again !== null ? [age, again].filter(Boolean).join(" · ") : labels.refresh;
  const handleRefresh = () => {
    if (held) return;
    // One refresh per click burst: a double click is one request.
    const at = Date.now();
    if (at - lastClick.current < REFRESH_CLICK_DEBOUNCE_MS) return;
    lastClick.current = at;
    onRefresh();
  };
  return { reading, held, age, again, title, handleRefresh };
}

/** The refresh icon button itself, as the usage card, the status bar and an
 * integration's pane draw it. */
export function RefreshIconButton({
  reading,
  held,
  title,
  onClick,
  label,
  className,
  outsideCard = false,
}: {
  reading: boolean;
  held: boolean;
  title: string;
  onClick: () => void;
  label: string;
  className?: string;
  /** Drawn outside the usage card (the status bar's): marks it so the open
   * card doesn't take a click on it for a click away from it. */
  outsideCard?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      aria-busy={reading}
      aria-disabled={held}
      data-usage-refresh={outsideCard || undefined}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center text-text-faint outline-hidden transition-colors focus-visible:bg-surface-hover",
        held ? "cursor-default opacity-50" : "cursor-pointer hover:bg-surface-hover hover:text-foreground",
        className,
      )}
    >
      <RotateCw className={cn("size-3.5", reading && "animate-spin")} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
