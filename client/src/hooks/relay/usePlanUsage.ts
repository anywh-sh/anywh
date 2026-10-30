import { useCallback, useEffect, useRef, useState } from "react";
import { useForegroundSync } from "@/hooks/relay/useForegroundSync";
import { EMPTY_PROFILE_USAGE, type ProfilePlanUsage } from "@/lib/planUsage/derive";
import type { PlanUsageRuntime } from "@/lib/planUsage/model";
import { PlanUsageWatch } from "@/lib/planUsage/watch";
import type { Profile } from "@/lib/profiles/profiles";

/** How often the clocks in the view move ("12s ago", "back in 58m"). The
 * numbers themselves arrive by push and are cached on the relay, so this
 * only re-renders; it never asks anything. */
export const PLAN_USAGE_CLOCK_MS = 60_000;

export interface PlanUsageState {
  /** Every profile in `profiles`, keyed by id — an entry exists from the
   * first render (`connecting`), so a view never has to handle a gap. */
  byProfile: Record<string, ProfilePlanUsage>;
  /** The view's clock, epoch ms, advanced every `PLAN_USAGE_CLOCK_MS`. */
  now: number;
  /** Ask the relay(s) for a new reading: one profile, or every connected one
   * when `profileId` is absent. `force: true` is the refresh button (always
   * reads); `false` is opening the card (cheap reads only). */
  refresh: (profileId?: string, force?: boolean, runtime?: PlanUsageRuntime) => void;
  /** Some profile's refresh hasn't been answered yet. */
  refreshing: boolean;
}

/** The fields that decide where and how a profile is dialed; any change
 * means a new connection. */
function connectionKey(profile: Profile): string {
  return JSON.stringify([
    profile.host,
    profile.relayPort,
    profile.connectToken,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
  ]);
}

interface Entry {
  key: string;
  watch: PlanUsageWatch;
}

/**
 * Plan usage of every profile at once, not only the active tab's: the status
 * bar alerts on another profile nearing its limit, and the card lists them
 * all. One `/plan-usage/watch` socket per profile, for as long as the hook is
 * mounted.
 *
 * Only the active tab's profile may wake a sleeping machine — on mount, and
 * again when a tab of that profile becomes active. Every other profile
 * connects with `wake: false` and, if its machine is asleep, shows its last
 * numbers as stale until something else brings it up.
 */
export function usePlanUsage(profiles: readonly Profile[], activeProfileId: string | null): PlanUsageState {
  const watchesRef = useRef(new Map<string, Entry>());
  const [byProfile, setByProfile] = useState<Record<string, ProfilePlanUsage>>({});
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef(activeProfileId);
  activeRef.current = activeProfileId;

  // Reconcile sockets with the profile list: open for new profiles, redial
  // a profile whose connection fields changed, close for removed ones.
  // Keyed on content, so a re-render with an equal list touches nothing.
  const profilesKey = JSON.stringify(profiles.map((profile) => [profile.id, connectionKey(profile)]));
  useEffect(() => {
    const watches = watchesRef.current;
    const wanted = new Set(profiles.map((profile) => profile.id));
    for (const [id, entry] of watches) {
      if (wanted.has(id)) continue;
      entry.watch.stop();
      watches.delete(id);
    }
    for (const profile of profiles) {
      const key = connectionKey(profile);
      const existing = watches.get(profile.id);
      if (existing?.key === key) continue;
      existing?.watch.stop();
      const watch = new PlanUsageWatch(profile, {
        wake: profile.id === activeRef.current,
        onChange: (state) => {
          if (watchesRef.current.get(profile.id)?.watch !== watch) return;
          setByProfile((prev) => ({ ...prev, [profile.id]: state }));
        },
      });
      watches.set(profile.id, { key, watch });
      watch.start();
    }
    setByProfile((prev) => {
      const next: Record<string, ProfilePlanUsage> = {};
      for (const [id, entry] of watches) next[id] = prev[id] ?? entry.watch.current;
      return next;
    });
    // `profiles` is read through `profilesKey`, which covers every field used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesKey]);

  useEffect(() => {
    const watches = watchesRef.current;
    return () => {
      for (const entry of watches.values()) entry.watch.stop();
      watches.clear();
    };
  }, []);

  // A tab of a profile became active: that is someone choosing to look at
  // it, the one later moment its machine may be woken.
  useEffect(() => {
    if (activeProfileId) watchesRef.current.get(activeProfileId)?.watch.retryNow({ wake: true });
  }, [activeProfileId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), PLAN_USAGE_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Back in the foreground: redial anything waiting out a retry, without
  // waking (glancing at the window is not a reason to resume a machine).
  const onForeground = useCallback(() => {
    for (const entry of watchesRef.current.values()) entry.watch.retryNow({ wake: false });
    setNow(Date.now());
  }, []);
  useForegroundSync(onForeground, { poll: false });

  const refresh = useCallback((profileId?: string, force = false, runtime?: PlanUsageRuntime) => {
    const targets = profileId ? [watchesRef.current.get(profileId)] : [...watchesRef.current.values()];
    for (const entry of targets) entry?.watch.refresh(force, runtime);
  }, []);

  const entries: Record<string, ProfilePlanUsage> = {};
  for (const profile of profiles) entries[profile.id] = byProfile[profile.id] ?? EMPTY_PROFILE_USAGE;

  return {
    byProfile: entries,
    now,
    refresh,
    refreshing: Object.values(entries).some((entry) => entry.refreshing),
  };
}
