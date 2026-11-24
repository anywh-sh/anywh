import type { RelayUpdateStatus } from "@/lib/relay/filesClient";

/**
 * How a self-update the app asked for ends, watched from outside: the relay
 * installs in the background and restarts onto the new release only once no
 * turn is in flight, so the app polls until the relay answers on that
 * release, says the install failed, or the watch runs out.
 *
 * Every answer the relay cannot give (it is restarting, or the network is
 * down) just counts as "not yet".
 */

export interface RelayUpdateWatchTiming {
  intervalMs: number;
  timeoutMs: number;
}

export const DEFAULT_WATCH_TIMING: RelayUpdateWatchTiming = { intervalMs: 30_000, timeoutMs: 20 * 60_000 };

export interface RelayUpdateWatchDeps {
  getVersion: () => Promise<string | undefined>;
  getStatus: () => Promise<RelayUpdateStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** False once the watch no longer concerns a relay the app has (the
   * profile was edited to another address, or removed): it stops. */
  active?: () => boolean;
}

export type RelayUpdateWatchOutcome =
  | { outcome: "done" }
  /** Called off (`active` turned false): nothing to report. */
  | { outcome: "stopped" }
  | { outcome: "failed"; code: string; step?: string }
  /** `lastState`: where the install last stood — `installed` is on disk,
   * waiting for the conversations' turns to end. */
  | { outcome: "gave_up"; lastState?: "installing" | "installed" };

export async function watchRelayUpdate(toVersion: string, deps: RelayUpdateWatchDeps, timing: RelayUpdateWatchTiming = DEFAULT_WATCH_TIMING): Promise<RelayUpdateWatchOutcome> {
  const deadline = deps.now() + timing.timeoutMs;
  let lastState: "installing" | "installed" | undefined;
  for (;;) {
    // The install takes a while: the first look is one interval in.
    await deps.sleep(timing.intervalMs);
    if (deps.active && !deps.active()) return { outcome: "stopped" };
    const version = await deps.getVersion().catch(() => undefined);
    if (version === toVersion) return { outcome: "done" };
    const status = await deps.getStatus().catch(() => null);
    if (status?.state === "failed" && status.version === toVersion) {
      return { outcome: "failed", code: status.code, ...(status.step !== undefined ? { step: status.step } : {}) };
    }
    if ((status?.state === "installing" || status?.state === "installed") && status.version === toVersion) lastState = status.state;
    if (deps.now() >= deadline) return lastState !== undefined ? { outcome: "gave_up", lastState } : { outcome: "gave_up" };
  }
}
