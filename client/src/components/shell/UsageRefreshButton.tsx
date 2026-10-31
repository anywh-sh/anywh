import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";

import { useDict, type Dictionary } from "@/i18n";
import { latestReadingAt, profileReading, refreshCooldown, type ProfileGroup } from "@/lib/planUsage/derive";
import { formatSpan, formatUpdatedAgo } from "@/lib/planUsage/format";
import { cn } from "@/lib/utils";

/** Clicks on refresh closer than this are one click. */
export const REFRESH_CLICK_DEBOUNCE_MS = 1_000;

/**
 * The state of a plan usage refresh button, from every profile's state:
 * - `reading`: a relay says a read runs — the icon turns. Never for having
 *   sent a refresh: one the relay answers from its cache comes back in
 *   milliseconds, with nothing read, and a spinner would only flash. With
 *   `userOnly`, only a read this client asked for counts.
 * - `held`: reading, or every relay would answer from its cache anyway
 *   (`refreshableAt`); a click then does nothing.
 * - `title`: how old the newest reading is and, while held by the floor,
 *   when a refresh can read again.
 */
export function useRefreshControl(
  groups: readonly ProfileGroup[],
  now: number,
  onRefresh: () => void,
  strings: Dictionary["shell"]["usage"],
  options: { userOnly?: boolean } = {},
) {
  const reading = groups.some((group) => profileReading(group.usage, now) && (!options.userOnly || group.usage.refreshing));
  const cooldown = refreshCooldown(groups, now);
  const held = reading || cooldown !== null;
  const lastClick = useRef(0);
  const latest = latestReadingAt(groups);
  const age = latest !== null ? formatUpdatedAgo(strings, latest, now) : null;
  const again = cooldown !== null ? strings.card.againIn.replace("{duration}", formatSpan(cooldown)) : null;
  const title = again !== null ? [age, again].filter(Boolean).join(" · ") : strings.card.refresh;
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

/** The refresh icon button itself, as both the card and the status bar draw it. */
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
  /** Drawn outside the card (the status bar's): marks it so the open card
   * doesn't take a click on it for a click away from it. */
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

/**
 * The status bar's refresh button, right after the usage indicator: the same
 * request and the same rules as the card's. Its icon turns only for a read
 * this client asked for — the relay's own minute reads would make it twitch
 * once a minute — and nothing in it changes size, so the bar never moves.
 *
 * The status bar's clock ticks once a minute; while held, this one ticks
 * every second so the countdown and the release are on time.
 */
export function UsageRefreshButton({ groups, onRefresh }: { groups: readonly ProfileGroup[]; onRefresh: () => void }) {
  const strings = useDict().shell.usage;
  const [now, setNow] = useState(() => Date.now());
  // A new state may start or end a hold: take the time again when one lands.
  const arrivals = groups.map((group) => group.usage.receivedAt ?? 0).join(",");
  useEffect(() => setNow(Date.now()), [arrivals]);
  const control = useRefreshControl(groups, now, onRefresh, strings, { userOnly: true });
  useEffect(() => {
    if (!control.held) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [control.held]);
  return (
    <RefreshIconButton
      reading={control.reading}
      held={control.held}
      title={control.title}
      onClick={control.handleRefresh}
      label={strings.card.refresh}
      className="size-5"
      outsideCard
    />
  );
}
