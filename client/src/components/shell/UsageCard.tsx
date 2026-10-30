import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { UsageAccountBlock } from "@/components/shell/UsageAccountBlock";
import { useDict, type Dictionary } from "@/i18n";
import { countAccounts, isReading, latestReadingAt, profileReading, refreshCooldown, type ProfileGroup } from "@/lib/planUsage/derive";
import { formatSpan, formatUpdatedAgo } from "@/lib/planUsage/format";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

type UsageStrings = Dictionary["shell"]["usage"];

/** Clicks on refresh closer than this are one click. */
export const REFRESH_CLICK_DEBOUNCE_MS = 1_000;

export interface UsageCardProps {
  groups: readonly ProfileGroup[];
  profileLabel: (profileId: string) => string;
  /** The refresh button: a forced read of every profile. */
  onRefresh: () => void;
}

/** A clock that ticks every second while the card is open — "12s ago" has
 * to move while someone is reading it. The card unmounts when closed, so
 * nothing ticks behind it. */
function useSecondClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The details behind the status bar's usage indicator: every profile's
 * accounts, the active tab's first, each window with its bar, percentage and
 * renewal. A popover anchored to the status bar (the caller's `Popover.Root`
 * and `Popover.Anchor`), so it sits on the bar's top edge, flush with the
 * window's left edge, above the indicator. The original design had it on
 * the right (mirroring an indicator on the right); both moved left on
 * purpose, at the owner's request.
 *
 * Its own look rather than the dropdown's: a border on the two sides that
 * face the app only (top and right — the other two are the window's edge and
 * the status bar), no shadow, and a 140ms rise out of the bar.
 */
export function UsageCard({ groups, profileLabel, onRefresh }: UsageCardProps) {
  const strings = useDict().shell.usage;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="top"
        align="start"
        sideOffset={0}
        collisionPadding={0}
        aria-label={strings.card.title}
        data-usage-card
        className="animate-usage-card-in z-50 flex max-h-(--radix-popover-content-available-height) w-[420px] flex-col border-t border-r border-border bg-background font-sans text-foreground outline-hidden"
      >
        <UsageCardBody groups={groups} profileLabel={profileLabel} onRefresh={onRefresh} strings={strings} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** The card's content, apart from the popover so a test can render it bare. */
export function UsageCardBody({
  groups,
  profileLabel,
  onRefresh,
  strings,
}: UsageCardProps & { strings: UsageStrings }) {
  const now = useSecondClock();
  const card = strings.card;
  const accounts = countAccounts(groups);
  // Spinning only while a relay says a read really runs (`reading`) — never
  // for having sent a refresh: one the relay answers from its cache comes
  // back in milliseconds, with nothing read, and a spinner would only flash.
  const reading = groups.some((group) => profileReading(group.usage, now));
  // Held while every relay would answer from its cache anyway.
  const cooldown = refreshCooldown(groups, now);
  const lastClick = useRef(0);
  const held = reading || cooldown !== null;
  const latest = latestReadingAt(groups);
  const age = latest !== null ? formatUpdatedAgo(strings, latest, now) : null;
  const again = cooldown !== null ? card.againIn.replace("{duration}", formatSpan(cooldown)) : null;
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("{count}", String(count)));

  const handleRefresh = () => {
    if (held) return;
    // One refresh per click burst: a double click is one request.
    const at = Date.now();
    if (at - lastClick.current < REFRESH_CLICK_DEBOUNCE_MS) return;
    lastClick.current = at;
    onRefresh();
  };

  return (
    <>
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-border-soft px-4">
        <h2 className="text-[13px] font-semibold">{card.title}</h2>
        <span className="font-mono text-[11px] text-text-faint">
          {plural(groups.length, card.profilesOne, card.profiles)} · {plural(accounts, card.accountsOne, card.accounts)}
        </span>
        <span className="flex-1" />
        {(age !== null || again !== null) && (
          <span data-usage-age className="font-mono text-[11px] text-text-faint">
            {[age, again].filter(Boolean).join(" · ")}
          </span>
        )}
        <button
          type="button"
          onClick={handleRefresh}
          aria-label={card.refresh}
          title={again !== null ? [age, again].filter(Boolean).join(" · ") : card.refresh}
          aria-busy={reading}
          aria-disabled={held}
          className={cn(
            "flex size-6 items-center justify-center text-text-faint outline-hidden transition-colors focus-visible:bg-surface-hover",
            held ? "cursor-default opacity-50" : "cursor-pointer hover:bg-surface-hover hover:text-foreground",
          )}
        >
          <RotateCw className={cn("size-3.5", reading && "animate-spin")} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map((group) => (
          <ProfileSection key={group.profileId} group={group} now={now} profileLabel={profileLabel} strings={strings} />
        ))}
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border-soft px-4 font-mono text-[11px] text-text-faint">
        <span aria-hidden="true" className="h-2.5 w-px bg-foreground" />
        {card.paceLegend}
      </footer>
    </>
  );
}

function ProfileSection({
  group,
  now,
  profileLabel,
  strings,
}: {
  group: ProfileGroup;
  now: number;
  profileLabel: (profileId: string) => string;
  strings: UsageStrings;
}) {
  const card = strings.card;
  const usage = group.usage;
  const state =
    group.data === "stale"
      ? card.staleSince.replace("{ago}", usage.receivedAt === null ? card.offline : formatUpdatedAgo(strings, usage.receivedAt, now))
      : group.data === "unsupported"
        ? card.unsupported
        : group.data === "none"
          ? usage.connection === "connecting"
            ? card.connecting
            : card.offline
          : null;

  return (
    <section data-usage-profile={group.profileId} data-active={group.active || undefined} data-state={group.data} aria-label={profileLabel(group.profileId)} className="pt-2">
      <div className="flex items-center gap-2 px-4 py-1">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0", profileColorClass(group.profileId))} />
        <span className="font-mono text-[12px] text-foreground">{profileLabel(group.profileId)}</span>
        {group.active && <span className="font-mono text-[10.5px] text-text-faint">{card.activeTab}</span>}
        <span aria-hidden="true" className="h-0 flex-1 border-t border-dashed border-border" />
        {state && <span className="font-mono text-[10.5px] text-text-faint">{state}</span>}
      </div>
      <div className={cn(group.data === "stale" && "opacity-60")}>
        {group.accounts.map((entry) => (
          <UsageAccountBlock
            key={entry.runtime}
            entry={entry}
            now={now}
            reading={group.data === "live" && isReading(entry.usage, usage.receivedAt, now)}
            profileLabel={profileLabel}
          />
        ))}
        {group.data === "live" && group.accounts.length === 0 && (
          <p className="px-4 py-2 font-mono text-[11px] text-text-faint">{card.noAgents}</p>
        )}
      </div>
    </section>
  );
}
