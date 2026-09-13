import { useEffect, useRef } from "react";
import { fetchSessions } from "@/lib/relayClient";
import { resolveConnection } from "@/lib/connectionResolver";
import { getCachedSessions, setCachedSessions } from "@/lib/sessionListCache";
import { useProfiles } from "@/hooks/useProfiles";
import { markProfileVerified } from "@/lib/profiles";

/**
 * Fills in the session list of profiles this device has never synced, once
 * each, and then never again.
 *
 * This used to be `useAllSessionNames`, which refetched every profile from
 * scratch each time Cmd+K opened. With the sidebar listing every profile at
 * once, that shape is both insufficient (the sidebar needs the rows before
 * anyone opens a search dialog) and wrong: a fan-out that repeats is the one
 * pattern this design deliberately avoids, since reaching a profile can mean
 * waking a machine that was asleep.
 *
 * What remains is a one-shot per profile per device. Everything after that
 * rides on connections the app was already making anyway: the active
 * profile's own fetch and live socket (`useSessionNames`), which follow the
 * user switching profiles or focusing a tab that belongs to another one.
 * A profile added later is picked up by the same rule — it starts with no
 * `syncedAt`, so it bootstraps when it appears, not on a timer. The active
 * profile is left out entirely, since `useSessionNames` already syncs it.
 */
export function useSessionListBootstrap(activeProfileId: string): void {
  const profiles = useProfiles();
  // Ids already attempted in this app run. Without it, a failed bootstrap
  // (relay unreachable) leaves `syncedAt` null forever, and every unrelated
  // change to the profiles list would retry it — turning the one-shot back
  // into the repeating fan-out this hook exists to avoid.
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    for (const profile of profiles) {
      // `useSessionNames` is already fetching this one, and duplicating it
      // is not free: resolving a connection to a brokered profile spends a
      // single-use token and can wake a sleeping machine. Deliberately not
      // recorded as attempted — if the active profile changes before this
      // one was ever synced, this effect re-runs and picks it up then.
      if (profile.id === activeProfileId) continue;
      if (attempted.current.has(profile.id)) continue;
      if (getCachedSessions(profile.id).syncedAt !== null) continue;
      attempted.current.add(profile.id);

      resolveConnection(profile)
        .then(({ host, port, token }) => fetchSessions(host, port, token))
        .then((sessions) => {
          setCachedSessions(profile.id, sessions);
          // A whole list came back: the profile is reachable, whatever an
          // interrupted setup left it marked as.
          markProfileVerified(profile.id);
        })
        .catch((error: unknown) => {
          // Deliberately quiet beyond the log: a profile that can't be
          // reached right now simply has no rows to show, which the sidebar
          // already renders as "never synced". Surfacing an error per
          // unreachable profile at startup would be noise, not information —
          // the active profile's own failure is the one the user can act on,
          // and `useSessionNames` reports that one.
          console.error("[anywh] failed to bootstrap the session list", profile.id, error);
        });
    }
  }, [profiles, activeProfileId]);
}
