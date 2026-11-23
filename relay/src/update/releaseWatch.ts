// Restart-on-new-release, shared by the relay and the agent host.
//
// An update swaps the install tree on disk (install-relay.sh) while the old
// processes keep running from memory. Each process then notices on its own
// that the release on disk is not the one it runs, and restarts itself — but
// only at a moment when nothing it holds would be cut: the relay when no
// conversation it runs has a turn in flight, the agent host when every agent
// is idle. The service manager (`Restart=always`) brings it back on the new
// code. Nothing here restarts anything a turn depends on: a busy process just
// tries again on the next tick.
import { readFileSync } from "node:fs";
import { parseRelease } from "./release.js";

export const RELEASE_WATCH_INTERVAL_MS = 30_000;

export interface ReleaseWatchOptions {
  /** The release this process runs. */
  readonly running: string;
  /** The release now on disk, or null when it cannot be read. */
  readonly readOnDisk: () => string | null;
  /** Whether restarting right now cuts nothing. May be async; whatever it
   * checked must still hold when `restart` runs (see `restart`). */
  readonly safeToRestart: () => boolean | Promise<boolean>;
  /** Begins the graceful shutdown. Called in the same tick as the last
   * check of `safeToRestart` (when that one is sync) or right after it. */
  readonly restart: (onDisk: string) => void;
  readonly intervalMs?: number;
  readonly log?: (line: string) => void;
}

export interface ReleaseWatch {
  /** One check now: true when it began a restart. */
  check(): Promise<boolean>;
  stop(): void;
}

/** Whether `onDisk` calls for a restart of a process running `running`: a
 * different, real release. A source checkout (the unreleased placeholder) or
 * an unreadable file never does. */
export function needsRestart(running: string, onDisk: string | null): onDisk is string {
  return onDisk !== null && onDisk !== running && parseRelease(onDisk) !== null;
}

export function watchForNewRelease(options: ReleaseWatchOptions): ReleaseWatch {
  let restarting = false;
  let checking = false;
  let deferredLogged = false;
  const log = options.log ?? ((line: string) => console.log(line));

  async function check(): Promise<boolean> {
    if (restarting || checking) return false;
    const onDisk = options.readOnDisk();
    if (!needsRestart(options.running, onDisk)) return false;
    checking = true;
    try {
      if (!(await options.safeToRestart())) {
        if (!deferredLogged) log(`release ${onDisk} is installed; restart deferred until no work is in flight`);
        deferredLogged = true;
        return false;
      }
      restarting = true;
      clearInterval(timer);
      log(`release ${onDisk} is installed (running ${options.running}); restarting to pick it up`);
      options.restart(onDisk);
      return true;
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(() => void check(), options.intervalMs ?? RELEASE_WATCH_INTERVAL_MS);
  timer.unref();
  return {
    check,
    stop: () => clearInterval(timer),
  };
}

/** Whether the relay may exit to pick up a new release: no conversation it
 * runs has a turn in flight, and its own installer is not running (the
 * swapped tree is what made the release visible, and exiting would take the
 * installer, a child in the same unit, down before it finished). */
export function relayRestartAllowed(turnInFlight: boolean, updater: { readonly state: string }): boolean {
  return !turnInFlight && updater.state !== "installing";
}

/** The `version` of a package.json, or null when it is missing or unreadable
 * (mid-swap, or a broken install). */
export function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Whether this process runs under a service manager that brings it back
 * after it exits: only then may it exit to pick up a new release. systemd
 * sets `INVOCATION_ID` for every unit it starts; `ANYWH_RESTART_ON_UPDATE`
 * overrides the detection either way (`1`/`0`). */
export function supervisedForRestart(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.ANYWH_RESTART_ON_UPDATE;
  if (override === "1") return true;
  if (override === "0") return false;
  return typeof env.INVOCATION_ID === "string" && env.INVOCATION_ID !== "";
}
