import { useState } from "react";
import { useLocalRelayProbe } from "@/hooks/platform/useLocalRelayProbe";
import { onInstallDone, startLocalInstall } from "@/lib/install/localRelay";
import { currentPlatform } from "@/lib/platform/platform";
import type { Profile } from "@/lib/profiles/profiles";

/** How a profile's relay can be brought up to date from here:
 * - `in-app`: it runs on this machine (not macOS) and the app can re-run
 *   its installer, which refreshes the relay on disk and leaves the running
 *   service alone (the new version runs from its next restart);
 * - `brew`: it runs on this Mac, where Homebrew owns it;
 * - `manual`: it runs elsewhere, so only a command on that machine can. */
export type RelayUpdateKind = "in-app" | "brew" | "manual";

export interface RelayUpdate {
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
  const local = profile.host === "127.0.0.1" && probe?.installedVersion != null;
  const kind: RelayUpdateKind = !local ? "manual" : currentPlatform() === "macos" ? "brew" : "in-app";

  async function run(): Promise<void> {
    if (kind !== "in-app") return;
    setStatus("running");
    setError(null);
    try {
      // The existing `.env`'s own host/port/home win the installer's resume
      // check (add-profile.sh) as long as they match what's already on
      // file, which this profile's own fields always do — so this is a
      // plain re-run, not a reprovision. It refreshes the relay tree on
      // disk and deliberately leaves the running service alone (same
      // reasoning as add-profile.sh's own "must not be the thing that
      // restarts a relay with a conversation in flight").
      const registered = probe?.profiles.find((p) => p.id === profile.id);
      await startLocalInstall({ profileId: profile.id, relayHost: profile.host, profileHome: registered?.homeOverride ?? undefined, mode: "prod" });
      const unlisten = await onInstallDone((event) => {
        setStatus(event.ok ? "done" : "failed");
        if (!event.ok) setError(event.failure?.message ?? null);
        unlisten();
      });
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return { kind, status, error, run };
}
