import { useEffect, useRef } from "react";
import { APP_VERSION } from "@/lib/install/appVersion";
import { getHostInfo, getRelayUpdateStatus, requestRelayUpdate, type HostInfo } from "@/lib/relay/filesClient";
import { shouldAutoUpdateRelay } from "@/lib/relay/relayDrift";
import { DEFAULT_WATCH_TIMING, watchRelayUpdate, type RelayUpdateWatchTiming } from "@/lib/relay/relayUpdateWatch";
import { trackRelaySeen, trackRelayUpdateFinished, trackRelayUpdateRequested } from "@/lib/telemetry/instrument";
import type { Profile } from "@/lib/profiles/profiles";

/** Relays already asked during this run of the app, by where they listen:
 * one request per relay per launch is enough — the relay itself keeps the
 * install going and restarts onto it when it is idle. */
const asked = new Set<string>();

/** For tests: forget which relays were asked. */
export function resetRelayAutoUpdate(): void {
  asked.clear();
}

/** A self-update's failure is reported once per relay and release, however
 * many launches read it back from the relay. */
const failureKey = (profile: Profile, version: string): string => `relay_update_failed:${profile.id}:${version}`;

/** A failure the relay still holds from an earlier request (one this app
 * may have quit before seeing), read before asking again, which replaces it. */
async function reportHeldFailure(profile: Profile, info: HostInfo): Promise<void> {
  if (!info.features?.includes("self_update")) return;
  const status = await getRelayUpdateStatus(profile).catch(() => null);
  if (status?.state !== "failed") return;
  trackRelayUpdateFinished(
    { path: "auto", outcome: "failed", reason: "installer", installerCode: status.code, installerStep: status.step, fromVersion: info.version, toVersion: status.version, startedAt: Date.now() },
    failureKey(profile, status.version),
  );
}

async function followUpdate(profile: Profile, fromVersion: string | undefined, toVersion: string, timing: RelayUpdateWatchTiming): Promise<void> {
  const startedAt = Date.now();
  const end = await watchRelayUpdate(
    toVersion,
    {
      getVersion: () => getHostInfo(profile).then((info) => info.version),
      getStatus: () => getRelayUpdateStatus(profile),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    },
    timing,
  );
  const base = { path: "auto" as const, fromVersion, toVersion, startedAt };
  if (end.outcome === "failed") {
    trackRelayUpdateFinished({ ...base, outcome: "failed", reason: "installer", installerCode: end.code, installerStep: end.step }, failureKey(profile, toVersion));
  } else {
    trackRelayUpdateFinished({ ...base, outcome: end.outcome, ...(end.outcome === "gave_up" && end.lastState ? { lastState: end.lastState } : {}) });
  }
}

/**
 * Brings every profile's relay up to this app's version with nobody asking:
 * on launch and whenever a profile is added or moves, each relay that can
 * update itself and runs an older release is asked to install the app's
 * version. The relay downloads it, verifies it and restarts onto it once no
 * turn is in flight, so a conversation never notices more than a reconnect.
 * Relays too old to update themselves are left to the per-profile
 * one-button update (useLegacyRelayUpgrade) — the last one they need.
 *
 * Each relay answered is counted once a day (its release and how it gets
 * updated), and each request is followed until the relay runs the new
 * release, says the install failed, or the watch gives up.
 */
export function useRelayAutoUpdate(profiles: readonly Profile[], appVersion: string = APP_VERSION, options: { watch?: Partial<RelayUpdateWatchTiming> } = {}): void {
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const watchRef = useRef(options.watch);
  watchRef.current = options.watch;
  const relays = JSON.stringify(profiles.map((p) => [p.id, p.host, p.relayPort]));

  useEffect(() => {
    for (const profile of profilesRef.current) {
      const key = `${profile.id}@${profile.host}:${profile.relayPort}`;
      if (asked.has(key)) continue;
      asked.add(key);
      void getHostInfo(profile)
        .then(async (info) => {
          trackRelaySeen(profile, info, appVersion);
          if (!shouldAutoUpdateRelay(info, appVersion)) return;
          await reportHeldFailure(profile, info);
          console.info(`[relay-update] ${profile.id}: relay ${info.version ?? "?"} is older than the app (${appVersion}); asking it to update`);
          try {
            await requestRelayUpdate(profile, appVersion);
          } catch (error) {
            trackRelayUpdateRequested(info.version, appVersion, error);
            throw error;
          }
          trackRelayUpdateRequested(info.version, appVersion);
          void followUpdate(profile, info.version, appVersion, { ...DEFAULT_WATCH_TIMING, ...watchRef.current });
        })
        .catch((error: unknown) => {
          // Unreachable now: try again on the next launch or profile change.
          asked.delete(key);
          console.warn(`[relay-update] ${profile.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  }, [relays, appVersion]);
}
