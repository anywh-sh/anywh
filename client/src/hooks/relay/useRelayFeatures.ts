import { useEffect, useState } from "react";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

export interface RelayFeatures {
  /** `unknown` until the relay answered (or when it could not be asked). */
  status: "unknown" | "known";
  version?: string;
  features: readonly string[];
}

/** What the profile's relay says it can do (`GET /host-info`). A relay that
 * predates the list answers without it, which is known: none. */
export function useRelayFeatures(profile: Profile): RelayFeatures {
  const [state, setState] = useState<RelayFeatures>({ status: "unknown", features: [] });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "unknown", features: [] });
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
  }, [profile.id, profile.host, profile.relayPort]);
  return state;
}

/** Whether the relay is known to lack `feature` (an unanswered one is not). */
export function lacksFeature(features: RelayFeatures, feature: string): boolean {
  return features.status === "known" && !features.features.includes(feature);
}
