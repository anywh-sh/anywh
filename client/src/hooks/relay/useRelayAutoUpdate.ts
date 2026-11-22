import { useEffect, useRef } from "react";
import { APP_VERSION } from "@/lib/install/appVersion";
import { getHostInfo, requestRelayUpdate } from "@/lib/relay/filesClient";
import { shouldAutoUpdateRelay } from "@/lib/relay/relayDrift";
import type { Profile } from "@/lib/profiles/profiles";

/** Relays already asked during this run of the app, by where they listen:
 * one request per relay per launch is enough — the relay itself keeps the
 * install going and restarts onto it when it is idle. */
const asked = new Set<string>();

/** For tests: forget which relays were asked. */
export function resetRelayAutoUpdate(): void {
  asked.clear();
}

/**
 * Brings every profile's relay up to this app's version with nobody asking:
 * on launch and whenever a profile is added or moves, each relay that can
 * update itself and runs an older release is asked to install the app's
 * version. The relay downloads it, verifies it and restarts onto it once no
 * turn is in flight, so a conversation never notices more than a reconnect.
 * Relays too old to update themselves are left to the per-profile
 * affordance (useRelayUpdate) — the last update they need by hand.
 */
export function useRelayAutoUpdate(profiles: readonly Profile[], appVersion: string = APP_VERSION): void {
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const relays = JSON.stringify(profiles.map((p) => [p.id, p.host, p.relayPort]));

  useEffect(() => {
    for (const profile of profilesRef.current) {
      const key = `${profile.id}@${profile.host}:${profile.relayPort}`;
      if (asked.has(key)) continue;
      asked.add(key);
      void getHostInfo(profile)
        .then(async (info) => {
          if (!shouldAutoUpdateRelay(info, appVersion)) return;
          console.info(`[relay-update] ${profile.id}: relay ${info.version ?? "?"} is older than the app (${appVersion}); asking it to update`);
          await requestRelayUpdate(profile, appVersion);
        })
        .catch((error: unknown) => {
          // Unreachable now: try again on the next launch or profile change.
          asked.delete(key);
          console.warn(`[relay-update] ${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  }, [relays, appVersion]);
}
