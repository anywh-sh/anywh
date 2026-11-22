import { useEffect, useRef, useState } from "react";
import { useLocalRelayProbe } from "@/hooks/platform/useLocalRelayProbe";
import { updateLocalRelay } from "@/lib/install/localRelayUpdate";
import { currentPlatform } from "@/lib/platform/platform";
import type { Profile } from "@/lib/profiles/profiles";

/** How a profile's relay can be brought up to date from here:
 * - `in-app`: it runs on this machine (not macOS) and the app can re-run
 *   its installer, which refreshes the relay on disk, then restart the
 *   service so the new version runs (the relay's graceful shutdown waits
 *   for turns in flight). Only needed once: from then on the relay updates
 *   itself (useRelayAutoUpdate);
 * - `brew`: it runs on this Mac, where Homebrew owns it;
 * - `manual`: it runs elsewhere, so only a command on that machine can. */
export type RelayUpdateKind = "in-app" | "brew" | "manual";

export interface RelayUpdate {
  /** The local relay probe this read (the caller's copy, not a second one). */
  probe: ReturnType<typeof useLocalRelayProbe>;
  kind: RelayUpdateKind;
  status: "idle" | "running" | "done" | "failed";
  error: string | null;
  run: () => Promise<void>;
}

/** What updating a profile's relay takes, and the in-app update itself. */
export function useRelayUpdate(profile: Profile): RelayUpdate {
  const probe = useLocalRelayProbe();
  const [status, setStatus] = useState<RelayUpdate["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  // The install's done listener, removed when it fires or when this unmounts.
  const unlistenRef = useRef<(() => void) | null>(null);
  useEffect(() => () => unlistenRef.current?.(), []);
  const local = profile.host === "127.0.0.1" && probe?.installedVersion != null;
  const kind: RelayUpdateKind = !local ? "manual" : currentPlatform() === "macos" ? "brew" : "in-app";

  async function run(): Promise<void> {
    if (kind !== "in-app") return;
    setStatus("running");
    setError(null);
    try {
      const registered = probe?.profiles.find((p) => p.id === profile.id);
      unlistenRef.current?.();
      await updateLocalRelay(profile, registered?.homeOverride ?? undefined, (unlisten) => (unlistenRef.current = unlisten));
      setStatus("done");
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unlistenRef.current = null;
    }
  }

  return { probe, kind, status, error, run };
}
