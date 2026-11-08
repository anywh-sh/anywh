import { useEffect, useState } from "react";

import { RefreshIconButton, useRefreshControl } from "@/components/shell/RefreshControl";
import { useDict, type Dictionary } from "@/i18n";
import { latestReadingAt, profileReading, refreshCooldown, type ProfileGroup } from "@/lib/planUsage/derive";
import { formatUpdatedAgo } from "@/lib/planUsage/format";

/**
 * The plan usage refresh control, from every profile's state (the generic
 * `useRefreshControl` fed by it):
 * - `reading`: a relay says a read runs. With `userOnly`, only a read this
 *   client asked for counts.
 * - `held`: reading, or every relay would answer from its cache anyway
 *   (`refreshableAt`).
 * - `title`: how old the newest reading is and, while held by the floor,
 *   when a refresh can read again.
 */
export function useUsageRefreshControl(
  groups: readonly ProfileGroup[],
  now: number,
  onRefresh: () => void,
  strings: Dictionary["shell"]["usage"],
  options: { userOnly?: boolean } = {},
) {
  const latest = latestReadingAt(groups);
  return useRefreshControl({
    reading: groups.some((group) => profileReading(group.usage, now) && (!options.userOnly || group.usage.refreshing)),
    cooldownMs: refreshCooldown(groups, now),
    age: latest !== null ? formatUpdatedAgo(strings, latest, now) : null,
    onRefresh,
    labels: { refresh: strings.card.refresh, againIn: strings.card.againIn },
  });
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
  const control = useUsageRefreshControl(groups, now, onRefresh, strings, { userOnly: true });
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
