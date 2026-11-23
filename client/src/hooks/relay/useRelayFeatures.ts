import { useEffect, useState } from "react";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

export interface RelayFeatures {
  /** `unknown` until the relay answered (or when it could not be asked). */
  status: "unknown" | "known";
  version?: string;
  features: readonly string[];
}

/** How often a relay known to lack the feature asked for is asked again: it
 * gains it when the person updates and restarts it, with no reload here. */
export const RELAY_FEATURES_RECHECK_MS = 30_000;

/** What the profile's relay says it can do (`GET /host-info`). A relay that
 * predates the list answers without it, which is known: none. With
 * `watchFor`, a relay known to lack that feature is asked again every
 * `RELAY_FEATURES_RECHECK_MS` until it has it. */
export function useRelayFeatures(profile: Profile, watchFor?: string): RelayFeatures {
  const [state, setState] = useState<RelayFeatures>({ status: "unknown", features: [] });
  const [check, setCheck] = useState(0);
  useEffect(() => {
    setState({ status: "unknown", features: [] });
  }, [profile.id, profile.host, profile.relayPort]);
  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile).then(
      (info) => {
        if (!cancelled) setState({ status: "known", ...(info.version ? { version: info.version } : {}), features: info.features ?? [] });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // The profile object is rebuilt on edits that do not change where it connects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.host, profile.relayPort, check]);
  const waiting = watchFor !== undefined && lacksFeature(state, watchFor);
  // An interval, not a timeout per answer: a check that fails (the relay
  // restarting) must not end the watch.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setCheck((n) => n + 1), RELAY_FEATURES_RECHECK_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return state;
}

/** Whether the relay is known to lack `feature` (an unanswered one is not). */
export function lacksFeature(features: RelayFeatures, feature: string): boolean {
  return features.status === "known" && !features.features.includes(feature);
}
