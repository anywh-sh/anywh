import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { UsageAccountBlock } from "@/components/shell/UsageAccountBlock";
import { useDict, type Dictionary } from "@/i18n";
import { countAccounts, type ProfileGroup } from "@/lib/planUsage/derive";
import { formatUpdatedAgo } from "@/lib/planUsage/format";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

type UsageStrings = Dictionary["shell"]["usage"];

export interface UsageCardProps {
  groups: readonly ProfileGroup[];
  profileLabel: (profileId: string) => string;
  refreshing: boolean;
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
 * window's right edge.
 *
 * Its own look rather than the dropdown's: a border on the two sides that
 * face the app only (top and left — the other two are the window's edge and
 * the status bar), no shadow, and a 140ms rise out of the bar.
 */
export function UsageCard({ groups, profileLabel, refreshing, onRefresh }: UsageCardProps) {
  const strings = useDict().shell.usage;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="top"
        align="end"
        sideOffset={0}
        collisionPadding={0}
        aria-label={strings.card.title}
        data-usage-card
        className="animate-usage-card-in z-50 flex max-h-(--radix-popover-content-available-height) w-[420px] flex-col border-t border-l border-border bg-background font-sans text-foreground outline-hidden"
      >
        <UsageCardBody groups={groups} profileLabel={profileLabel} refreshing={refreshing} onRefresh={onRefresh} strings={strings} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** The card's content, apart from the popover so a test can render it bare. */
export function UsageCardBody({
  groups,
  profileLabel,
  refreshing,
  onRefresh,
  strings,
}: UsageCardProps & { strings: UsageStrings }) {
  const now = useSecondClock();
  const card = strings.card;
  const accounts = countAccounts(groups);
  const received = groups
    .filter((group) => group.data === "live")
    .map((group) => group.usage.receivedAt)
    .filter((at): at is number => at !== null);
  const freshest = received.length > 0 ? Math.max(...received) : null;
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("{count}", String(count)));

  return (
    <>
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-border-soft px-4">
        <h2 className="text-[13px] font-semibold">{card.title}</h2>
        <span className="font-mono text-[11px] text-text-faint">
          {plural(groups.length, card.profilesOne, card.profiles)} · {plural(accounts, card.accountsOne, card.accounts)}
        </span>
        <span className="flex-1" />
        {freshest !== null && (
          <span data-usage-age className="font-mono text-[11px] text-text-faint">
            {formatUpdatedAgo(strings, freshest, now)}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          aria-label={card.refresh}
          title={card.refresh}
          aria-busy={refreshing}
          disabled={refreshing}
          className="flex size-6 cursor-pointer items-center justify-center text-text-faint outline-hidden transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:bg-surface-hover disabled:cursor-default"
        >
          <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} strokeWidth={1.5} aria-hidden="true" />
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
          <UsageAccountBlock key={entry.runtime} entry={entry} now={now} profileLabel={profileLabel} />
        ))}
        {group.data === "live" && group.accounts.length === 0 && (
          <p className="px-4 py-2 font-mono text-[11px] text-text-faint">{card.noAgents}</p>
        )}
      </div>
    </section>
  );
}
