import { onInstallDone, restartLocalRelay, startLocalInstall, type InstallDoneEvent } from "@/lib/install/localRelay";
import type { Profile } from "@/lib/profiles/profiles";

/**
 * Re-runs the in-app installer for a profile whose relay runs on this
 * machine (Linux), then restarts its service so the new release is what
 * runs; resolves once both are done, rejects with the installer's or
 * systemctl's reason. The restart is the relay's graceful shutdown: it stops
 * taking new turns and waits for the ones in flight.
 *
 * The existing `.env`'s own host/port/home win the installer's resume check
 * (add-profile.sh) as long as they match what's already on file, which this
 * profile's own fields always do — so this is a plain re-run, not a
 * reprovision. `onListening` receives the installer listener's remover, for
 * a caller that may unmount before the install ends.
 */
export async function updateLocalRelay(profile: Profile, profileHome: string | undefined, onListening?: (unlisten: () => void) => void): Promise<void> {
  // Listening before starting: an install that ends at once (nothing to
  // update, or failing on its first step) can report before the start
  // resolves. Its event is kept until this run's id is known.
  let runId: string | null = null;
  const early: InstallDoneEvent[] = [];
  let resolveEnded: (event: InstallDoneEvent) => void = () => undefined;
  const ended = new Promise<InstallDoneEvent>((resolve) => (resolveEnded = resolve));
  const unlisten = await onInstallDone((event) => {
    if (runId === null) early.push(event);
    else if (event.runId === runId) resolveEnded(event);
  });
  onListening?.(unlisten);
  try {
    const info = await startLocalInstall({ profileId: profile.id, relayHost: profile.host, profileHome, mode: "prod" });
    runId = info.runId;
    const event = early.find((candidate) => candidate.runId === runId) ?? (await ended);
    if (!event.ok) throw new Error(event.failure?.message ?? "the relay installer failed");
  } finally {
    unlisten();
  }
  // The tree on disk is new; the service still runs the old one, which
  // predates restarting itself onto a release.
  await restartLocalRelay(profile.id);
}
